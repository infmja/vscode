/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from 'vs/nls';
import { escapeRegExpCharacters } from 'vs/base/common/strings';
import { ITelemetryService, ITelemetryInfo, ITelemetryData } from 'vs/platform/telemetry/common/telemetry';
import { ITelemetryAppender } from 'vs/platform/telemetry/common/telemetryUtils';
import { optional } from 'vs/platform/instantiation/common/instantiation';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { IConfigurationRegistry, Extensions } from 'vs/platform/configuration/common/configurationRegistry';
import { IDisposable, dispose } from 'vs/base/common/lifecycle';
import { cloneAndChange, mixin } from 'vs/base/common/objects';
import { Registry } from 'vs/platform/registry/common/platform';
import { ClassifiedEvent, StrictPropertyCheck, GDPRClassification } from 'vs/platform/telemetry/common/gdprTypings';

export interface ITelemetryServiceConfig {
	appender: ITelemetryAppender;
	commonProperties?: Promise<{ [name: string]: any }>;
	piiPaths?: string[];
}

export class TelemetryService implements ITelemetryService {

	static IDLE_START_EVENT_NAME = 'UserIdleStart';
	static IDLE_STOP_EVENT_NAME = 'UserIdleStop';

	_serviceBrand: any;

	private _appender: ITelemetryAppender;
	private _commonProperties: Promise<{ [name: string]: any; }>;
	private _piiPaths: string[];
	private _userOptIn: boolean;
	private _enabled: boolean;

	private _disposables: IDisposable[] = [];
	private _cleanupPatterns: RegExp[] = [];

	constructor(
		config: ITelemetryServiceConfig,
		@optional(IConfigurationService) private _configurationService: IConfigurationService
	) {
		this._appender = config.appender;
		this._commonProperties = config.commonProperties || Promise.resolve({});
		this._piiPaths = config.piiPaths || [];
		this._userOptIn = true;
		this._enabled = true;

		// static cleanup pattern for: `file:///DANGEROUS/PATH/resources/app/Useful/Information`
		this._cleanupPatterns = [/file:\/\/\/.*?\/resources\/app\//gi];

		for (let piiPath of this._piiPaths) {
			this._cleanupPatterns.push(new RegExp(escapeRegExpCharacters(piiPath), 'gi'));
		}

		if (this._configurationService) {
			this._updateUserOptIn();
			this._configurationService.onDidChangeConfiguration(this._updateUserOptIn, this, this._disposables);
			type OptInClass = {
				optIn: { classification: 'SystemMetaData', purpose: 'BusinessInsight', isMeasurement: true };
			};
			type OptInEvent = {
				optIn: boolean;
			};
			this.publicLog2<OptInEvent, OptInClass>('optInStatus', { optIn: this._userOptIn });

			this._commonProperties.then(values => {
				const isHashedId = /^[a-f0-9]+$/i.test(values['common.machineId']);

				/* __GDPR__
					"machineIdFallback" : {
						"usingFallbackGuid" : { "classification": "SystemMetaData", "purpose": "BusinessInsight", "isMeasurement": true }
					}
				*/
				this.publicLog('machineIdFallback', { usingFallbackGuid: !isHashedId });
			});
		}
	}

	setEnabled(value: boolean): void {
		this._enabled = value;
	}

	private _updateUserOptIn(): void {
		const config = this._configurationService.getValue<any>(TELEMETRY_SECTION_ID);
		this._userOptIn = config ? config.enableTelemetry : this._userOptIn;
	}

	get isOptedIn(): boolean {
		return this._userOptIn && this._enabled;
	}

	async getTelemetryInfo(): Promise<ITelemetryInfo> {
		const values = await this._commonProperties;

		// well known properties
		let sessionId = values['sessionID'];
		let instanceId = values['common.instanceId'];
		let machineId = values['common.machineId'];

		return { sessionId, instanceId, machineId };
	}

	dispose(): void {
		this._disposables = dispose(this._disposables);
	}

	publicLog(eventName: string, data?: ITelemetryData, anonymizeFilePaths?: boolean): Promise<any> {
		// don't send events when the user is optout
		if (!this.isOptedIn) {
			return Promise.resolve(undefined);
		}

		return this._commonProperties.then(values => {

			// (first) add common properties
			data = mixin(data, values);

			// (last) remove all PII from data
			data = cloneAndChange(data, value => {
				if (typeof value === 'string') {
					return this._cleanupInfo(value, anonymizeFilePaths);
				}
				return undefined;
			});

			this._appender.log(eventName, data);

		}, err => {
			// unsure what to do now...
			console.error(err);
		});
	}

	publicLog2<E extends ClassifiedEvent<T> = never, T extends GDPRClassification<T> = never>(eventName: string, data?: StrictPropertyCheck<T, E>, anonymizeFilePaths?: boolean): Promise<any> {
		return this.publicLog(eventName, data as ITelemetryData, anonymizeFilePaths);
	}

	private _cleanupInfo(stack: string, anonymizeFilePaths?: boolean): string {
		let updatedStack = stack;

		if (anonymizeFilePaths) {
			const cleanUpIndexes: [number, number][] = [];
			for (let regexp of this._cleanupPatterns) {
				while (true) {
					const result = regexp.exec(stack);
					if (!result) {
						break;
					}
					cleanUpIndexes.push([result.index, regexp.lastIndex]);
				}
			}

			const nodeModulesRegex = /^[\\\/]?(node_modules|node_modules\.asar)[\\\/]/;
			const fileRegex = /(file:\/\/)?([a-zA-Z]:(\\\\|\\|\/)|(\\\\|\\|\/))?([\w-\._]+(\\\\|\\|\/))+[\w-\._]*/g;
			let lastIndex = 0;
			updatedStack = '';

			while (true) {
				const result = fileRegex.exec(stack);
				if (!result) {
					break;
				}
				// Anoynimize user file paths that do not need to be retained or cleaned up.
				if (!nodeModulesRegex.test(result[0]) && cleanUpIndexes.every(([x, y]) => result.index < x || result.index >= y)) {
					updatedStack += stack.substring(lastIndex, result.index) + '<REDACTED: user-file-path>';
					lastIndex = fileRegex.lastIndex;
				}
			}
			if (lastIndex < stack.length) {
				updatedStack += stack.substr(lastIndex);
			}
		}

		// sanitize with configured cleanup patterns
		for (let regexp of this._cleanupPatterns) {
			updatedStack = updatedStack.replace(regexp, '');
		}
		return updatedStack;
	}
}


const TELEMETRY_SECTION_ID = 'telemetry';

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	'id': TELEMETRY_SECTION_ID,
	'order': 110,
	'type': 'object',
	'title': localize('telemetryConfigurationTitle', "Telemetry"),
	'properties': {
		'telemetry.enableTelemetry': {
			'type': 'boolean',
			'description': localize('telemetry.enableTelemetry', "Enable usage data and errors to be sent to a Microsoft online service."),
			'default': true,
			'tags': ['usesOnlineServices']
		}
	}
});
