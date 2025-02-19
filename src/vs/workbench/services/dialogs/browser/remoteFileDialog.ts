/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as nls from 'vs/nls';
import * as resources from 'vs/base/common/resources';
import * as objects from 'vs/base/common/objects';
import { IFileService, IFileStat, FileKind } from 'vs/platform/files/common/files';
import { IQuickInputService, IQuickPickItem, IQuickPick } from 'vs/platform/quickinput/common/quickInput';
import { URI } from 'vs/base/common/uri';
import { isWindows, OperatingSystem } from 'vs/base/common/platform';
import { ISaveDialogOptions, IOpenDialogOptions, IFileDialogService } from 'vs/platform/dialogs/common/dialogs';
import { REMOTE_HOST_SCHEME } from 'vs/platform/remote/common/remoteHosts';
import { ILabelService } from 'vs/platform/label/common/label';
import { IWorkspaceContextService } from 'vs/platform/workspace/common/workspace';
import { INotificationService } from 'vs/platform/notification/common/notification';
import { IModelService } from 'vs/editor/common/services/modelService';
import { IModeService } from 'vs/editor/common/services/modeService';
import { getIconClasses } from 'vs/editor/common/services/getIconClasses';
import { Schemas } from 'vs/base/common/network';
import { IWorkbenchEnvironmentService } from 'vs/workbench/services/environment/common/environmentService';
import { IRemoteAgentService } from 'vs/workbench/services/remote/common/remoteAgentService';
import { IContextKeyService, IContextKey } from 'vs/platform/contextkey/common/contextkey';
import { equalsIgnoreCase, format, startsWithIgnoreCase } from 'vs/base/common/strings';
import { OpenLocalFileCommand, OpenLocalFileFolderCommand, OpenLocalFolderCommand, SaveLocalFileCommand } from 'vs/workbench/browser/actions/workspaceActions';
import { IKeybindingService } from 'vs/platform/keybinding/common/keybinding';
import { IRemoteAgentEnvironment } from 'vs/platform/remote/common/remoteAgentEnvironment';
import { isValidBasename } from 'vs/base/common/extpath';
import { RemoteFileDialogContext } from 'vs/workbench/browser/contextkeys';
import { Emitter } from 'vs/base/common/event';
import { IDisposable, dispose } from 'vs/base/common/lifecycle';

interface FileQuickPickItem extends IQuickPickItem {
	uri: URI;
	isFolder: boolean;
}

enum UpdateResult {
	Updated,
	Updating,
	NotUpdated,
	InvalidPath
}

export class RemoteFileDialog {
	private options: IOpenDialogOptions;
	private currentFolder: URI;
	private filePickBox: IQuickPick<FileQuickPickItem>;
	private hidden: boolean;
	private allowFileSelection: boolean;
	private allowFolderSelection: boolean;
	private remoteAuthority: string | undefined;
	private requiresTrailing: boolean;
	private trailing: string | undefined;
	private scheme: string = REMOTE_HOST_SCHEME;
	private contextKey: IContextKey<boolean>;
	private userEnteredPathSegment: string;
	private autoCompletePathSegment: string;
	private activeItem: FileQuickPickItem;
	private userHome: URI;
	private badPath: string | undefined;
	private remoteAgentEnvironment: IRemoteAgentEnvironment | null;
	private separator: string;
	private onBusyChangeEmitter = new Emitter<boolean>();

	protected disposables: IDisposable[] = [
		this.onBusyChangeEmitter
	];

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@ILabelService private readonly labelService: ILabelService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@INotificationService private readonly notificationService: INotificationService,
		@IFileDialogService private readonly fileDialogService: IFileDialogService,
		@IModelService private readonly modelService: IModelService,
		@IModeService private readonly modeService: IModeService,
		@IWorkbenchEnvironmentService private readonly environmentService: IWorkbenchEnvironmentService,
		@IRemoteAgentService private readonly remoteAgentService: IRemoteAgentService,
		@IKeybindingService private readonly keybindingService: IKeybindingService,
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		this.remoteAuthority = this.environmentService.configuration.remoteAuthority;
		this.contextKey = RemoteFileDialogContext.bindTo(contextKeyService);
	}

	set busy(busy: boolean) {
		if (this.filePickBox.busy !== busy) {
			this.filePickBox.busy = busy;
			this.onBusyChangeEmitter.fire(busy);
		}
	}

	get busy(): boolean {
		return this.filePickBox.busy;
	}

	public async showOpenDialog(options: IOpenDialogOptions = {}): Promise<URI | undefined> {
		this.scheme = this.getScheme(options.availableFileSystems);
		this.userHome = await this.getUserHome();
		const newOptions = await this.getOptions(options);
		if (!newOptions) {
			return Promise.resolve(undefined);
		}
		this.options = newOptions;
		return this.pickResource();
	}

	public async showSaveDialog(options: ISaveDialogOptions): Promise<URI | undefined> {
		this.scheme = this.getScheme(options.availableFileSystems);
		this.userHome = await this.getUserHome();
		this.requiresTrailing = true;
		const newOptions = await this.getOptions(options, true);
		if (!newOptions) {
			return Promise.resolve(undefined);
		}
		this.options = newOptions;
		this.options.canSelectFolders = true;
		this.options.canSelectFiles = true;

		return new Promise<URI | undefined>((resolve) => {
			this.pickResource(true).then(folderUri => {
				resolve(folderUri);
			});
		});
	}

	private getOptions(options: ISaveDialogOptions | IOpenDialogOptions, isSave: boolean = false): IOpenDialogOptions | undefined {
		let defaultUri: URI | undefined = undefined;
		let filename: string | undefined = undefined;
		if (options.defaultUri) {
			defaultUri = (this.scheme === options.defaultUri.scheme) ? options.defaultUri : undefined;
			filename = isSave ? resources.basename(options.defaultUri) : undefined;
		}
		if (!defaultUri) {
			defaultUri = this.userHome;
			if (filename) {
				defaultUri = resources.joinPath(defaultUri, filename);
			}
		}
		if ((this.scheme !== Schemas.file) && !this.fileService.canHandleResource(defaultUri)) {
			this.notificationService.info(nls.localize('remoteFileDialog.notConnectedToRemote', 'File system provider for {0} is not available.', defaultUri.toString()));
			return undefined;
		}
		const newOptions: IOpenDialogOptions = objects.deepClone(options);
		newOptions.defaultUri = defaultUri;
		return newOptions;
	}

	private remoteUriFrom(path: string): URI {
		path = path.replace(/\\/g, '/');
		return resources.toLocalResource(URI.from({ scheme: this.scheme, path }), this.scheme === Schemas.file ? undefined : this.remoteAuthority);
	}

	private getScheme(available: string[] | undefined): string {
		return available ? available[0] : Schemas.file;
	}

	private async getRemoteAgentEnvironment(): Promise<IRemoteAgentEnvironment | null> {
		if (this.remoteAgentEnvironment === undefined) {
			this.remoteAgentEnvironment = await this.remoteAgentService.getEnvironment();
		}
		return this.remoteAgentEnvironment;
	}

	private async getUserHome(): Promise<URI> {
		if (this.scheme !== Schemas.file) {
			const env = await this.getRemoteAgentEnvironment();
			if (env) {
				return env.userHome;
			}
		}
		return URI.from({ scheme: this.scheme, path: this.environmentService.userHome });
	}

	private async pickResource(isSave: boolean = false): Promise<URI | undefined> {
		this.allowFolderSelection = !!this.options.canSelectFolders;
		this.allowFileSelection = !!this.options.canSelectFiles;
		this.separator = this.labelService.getSeparator(this.scheme, this.remoteAuthority);
		this.hidden = false;
		let homedir: URI = this.options.defaultUri ? this.options.defaultUri : this.workspaceContextService.getWorkspace().folders[0].uri;
		let stat: IFileStat | undefined;
		let ext: string = resources.extname(homedir);
		if (this.options.defaultUri) {
			try {
				stat = await this.fileService.resolve(this.options.defaultUri);
			} catch (e) {
				// The file or folder doesn't exist
			}
			if (!stat || !stat.isDirectory) {
				homedir = resources.dirname(this.options.defaultUri);
				this.trailing = resources.basename(this.options.defaultUri);
			}
			// append extension
			if (isSave && !ext && this.options.filters) {
				for (let i = 0; i < this.options.filters.length; i++) {
					if (this.options.filters[i].extensions[0] !== '*') {
						ext = '.' + this.options.filters[i].extensions[0];
						this.trailing = this.trailing ? this.trailing + ext : ext;
						break;
					}
				}
			}
		}

		return new Promise<URI | undefined>(async (resolve) => {
			this.filePickBox = this.quickInputService.createQuickPick<FileQuickPickItem>();
			this.busy = true;
			this.filePickBox.matchOnLabel = false;
			this.filePickBox.autoFocusOnList = false;
			this.filePickBox.ignoreFocusOut = true;
			this.filePickBox.ok = true;
			if (this.options && this.options.availableFileSystems && (this.options.availableFileSystems.length > 1)) {
				this.filePickBox.customButton = true;
				this.filePickBox.customLabel = nls.localize('remoteFileDialog.local', 'Show Local');
				let action;
				if (isSave) {
					action = SaveLocalFileCommand;
				} else {
					action = this.allowFileSelection ? (this.allowFolderSelection ? OpenLocalFileFolderCommand : OpenLocalFileCommand) : OpenLocalFolderCommand;
				}
				const keybinding = this.keybindingService.lookupKeybinding(action.ID);
				if (keybinding) {
					const label = keybinding.getLabel();
					if (label) {
						this.filePickBox.customHover = format('{0} ({1})', action.LABEL, label);
					}
				}
			}

			let isResolving: number = 0;
			let isAcceptHandled = false;
			this.currentFolder = homedir;
			this.userEnteredPathSegment = '';
			this.autoCompletePathSegment = '';

			this.filePickBox.title = this.options.title;
			this.filePickBox.value = this.pathFromUri(this.currentFolder, true);
			this.filePickBox.valueSelection = [this.filePickBox.value.length, this.filePickBox.value.length];
			this.filePickBox.items = [];

			function doResolve(dialog: RemoteFileDialog, uri: URI | undefined) {
				if (uri) {
					uri = resources.removeTrailingPathSeparator(uri);
				}
				resolve(uri);
				dialog.contextKey.set(false);
				dialog.filePickBox.dispose();
				dispose(dialog.disposables);
			}

			this.filePickBox.onDidCustom(() => {
				if (isAcceptHandled || this.busy) {
					return;
				}

				isAcceptHandled = true;
				isResolving++;
				if (this.options.availableFileSystems && (this.options.availableFileSystems.length > 1)) {
					this.options.availableFileSystems.shift();
				}
				this.filePickBox.hide();
				if (isSave) {
					return this.fileDialogService.showSaveDialog(this.options).then(result => {
						doResolve(this, result);
					});
				} else {
					return this.fileDialogService.showOpenDialog(this.options).then(result => {
						doResolve(this, result ? result[0] : undefined);
					});
				}
			});

			function handleAccept(dialog: RemoteFileDialog) {
				if (dialog.busy) {
					// Save the accept until the file picker is not busy.
					dialog.onBusyChangeEmitter.event((busy: boolean) => {
						if (!busy) {
							handleAccept(dialog);
						}
					});
					return;
				} else if (isAcceptHandled) {
					return;
				}

				isAcceptHandled = true;
				isResolving++;
				dialog.onDidAccept().then(resolveValue => {
					if (resolveValue) {
						dialog.filePickBox.hide();
						doResolve(dialog, resolveValue);
					} else if (dialog.hidden) {
						doResolve(dialog, undefined);
					} else {
						isResolving--;
						isAcceptHandled = false;
					}
				});
			}

			this.filePickBox.onDidAccept(_ => {
				handleAccept(this);
			});

			this.filePickBox.onDidChangeActive(i => {
				isAcceptHandled = false;
				// update input box to match the first selected item
				if ((i.length === 1) && this.isChangeFromUser()) {
					this.filePickBox.validationMessage = undefined;
					this.setAutoComplete(this.constructFullUserPath(), this.userEnteredPathSegment, i[0], true);
				}
			});

			this.filePickBox.onDidChangeValue(async value => {
				try {
					// onDidChangeValue can also be triggered by the auto complete, so if it looks like the auto complete, don't do anything
					if (this.isChangeFromUser()) {
						// If the user has just entered more bad path, don't change anything
						if (!equalsIgnoreCase(value, this.constructFullUserPath()) && !this.isBadSubpath(value)) {
							this.filePickBox.validationMessage = undefined;
							const filePickBoxUri = this.filePickBoxValue();
							let updated: UpdateResult = UpdateResult.NotUpdated;
							if (!resources.isEqual(this.currentFolder, filePickBoxUri, true)) {
								updated = await this.tryUpdateItems(value, filePickBoxUri);
							}
							if (updated === UpdateResult.NotUpdated) {
								this.setActiveItems(value);
							}
						} else {
							this.filePickBox.activeItems = [];
							this.userEnteredPathSegment = '';
						}
					}
				} catch {
					// Since any text can be entered in the input box, there is potential for error causing input. If this happens, do nothing.
				}
			});
			this.filePickBox.onDidHide(() => {
				this.hidden = true;
				if (isResolving === 0) {
					doResolve(this, undefined);
				}
			});

			this.filePickBox.show();
			this.contextKey.set(true);
			await this.updateItems(homedir, true, this.trailing);
			if (this.trailing) {
				this.filePickBox.valueSelection = [this.filePickBox.value.length - this.trailing.length, this.filePickBox.value.length - ext.length];
			} else {
				this.filePickBox.valueSelection = [this.filePickBox.value.length, this.filePickBox.value.length];
			}
			this.busy = false;
		});
	}

	private isBadSubpath(value: string) {
		return this.badPath && (value.length > this.badPath.length) && equalsIgnoreCase(value.substring(0, this.badPath.length), this.badPath);
	}

	private isChangeFromUser(): boolean {
		if (equalsIgnoreCase(this.filePickBox.value, this.pathAppend(this.currentFolder, this.userEnteredPathSegment + this.autoCompletePathSegment))
			&& (this.activeItem === (this.filePickBox.activeItems ? this.filePickBox.activeItems[0] : undefined))) {
			return false;
		}
		return true;
	}

	private constructFullUserPath(): string {
		if (equalsIgnoreCase(this.filePickBox.value.substr(0, this.userEnteredPathSegment.length), this.userEnteredPathSegment)) {
			return this.pathFromUri(this.currentFolder);
		} else {
			return this.pathAppend(this.currentFolder, this.userEnteredPathSegment);
		}
	}

	private filePickBoxValue(): URI {
		// The file pick box can't render everything, so we use the current folder to create the uri so that it is an existing path.
		const directUri = this.remoteUriFrom(this.filePickBox.value);
		const currentPath = this.pathFromUri(this.currentFolder);
		if (equalsIgnoreCase(this.filePickBox.value, currentPath)) {
			return this.currentFolder;
		}
		const currentDisplayUri = this.remoteUriFrom(currentPath);
		const relativePath = resources.relativePath(currentDisplayUri, directUri);
		const isSameRoot = (this.filePickBox.value.length > 1 && currentPath.length > 1) ? equalsIgnoreCase(this.filePickBox.value.substr(0, 2), currentPath.substr(0, 2)) : false;
		if (relativePath && isSameRoot) {
			let path = resources.joinPath(this.currentFolder, relativePath);
			const directBasename = resources.basename(directUri);
			if ((directBasename === '.') || (directBasename === '..')) {
				path = this.remoteUriFrom(this.pathAppend(path, directBasename));
			}
			return resources.hasTrailingPathSeparator(directUri) ? resources.addTrailingPathSeparator(path) : path;
		} else {
			return directUri;
		}
	}

	private async onDidAccept(): Promise<URI | undefined> {
		this.busy = true;
		if (this.filePickBox.activeItems.length === 1) {
			const item = this.filePickBox.selectedItems[0];
			if (item.isFolder) {
				if (this.trailing) {
					await this.updateItems(item.uri, true, this.trailing);
				} else {
					// When possible, cause the update to happen by modifying the input box.
					// This allows all input box updates to happen first, and uses the same code path as the user typing.
					const newPath = this.pathFromUri(item.uri);
					if (startsWithIgnoreCase(newPath, this.filePickBox.value) && (equalsIgnoreCase(item.label, resources.basename(item.uri)))) {
						this.filePickBox.valueSelection = [this.pathFromUri(this.currentFolder).length, this.filePickBox.value.length];
						this.insertText(newPath, item.label);
					} else if ((item.label === '..') && startsWithIgnoreCase(this.filePickBox.value, newPath)) {
						this.filePickBox.valueSelection = [newPath.length, this.filePickBox.value.length];
						this.insertText(newPath, '');
					} else {
						await this.updateItems(item.uri, true);
					}
				}
				this.filePickBox.busy = false;
				return;
			}
		} else {
			// If the items have updated, don't try to resolve
			if ((await this.tryUpdateItems(this.filePickBox.value, this.filePickBoxValue())) !== UpdateResult.NotUpdated) {
				this.filePickBox.busy = false;
				return;
			}
		}

		let resolveValue: URI | undefined;
		// Find resolve value
		if (this.filePickBox.activeItems.length === 0) {
			resolveValue = this.filePickBoxValue();
		} else if (this.filePickBox.activeItems.length === 1) {
			resolveValue = this.filePickBox.selectedItems[0].uri;
		}
		if (resolveValue) {
			resolveValue = this.addPostfix(resolveValue);
		}
		if (await this.validate(resolveValue)) {
			this.busy = false;
			return resolveValue;
		}
		this.busy = false;
		return undefined;
	}

	private async tryUpdateItems(value: string, valueUri: URI): Promise<UpdateResult> {
		if ((value.length > 0) && ((value[value.length - 1] === '~') || (value[0] === '~'))) {
			let newDir = this.userHome;
			if ((value[0] === '~') && (value.length > 1)) {
				newDir = resources.joinPath(newDir, value.substring(1));
			}
			await this.updateItems(newDir, true);
			return UpdateResult.Updated;
		} else if (!resources.isEqual(this.currentFolder, valueUri, true) && (this.endsWithSlash(value) || (!resources.isEqual(this.currentFolder, resources.dirname(valueUri), true) && resources.isEqualOrParent(this.currentFolder, resources.dirname(valueUri), true)))) {
			let stat: IFileStat | undefined;
			try {
				stat = await this.fileService.resolve(valueUri);
			} catch (e) {
				// do nothing
			}
			if (stat && stat.isDirectory && (resources.basename(valueUri) !== '.') && this.endsWithSlash(value)) {
				await this.updateItems(valueUri);
				return UpdateResult.Updated;
			} else if (this.endsWithSlash(value)) {
				// The input box contains a path that doesn't exist on the system.
				this.filePickBox.validationMessage = nls.localize('remoteFileDialog.badPath', 'The path does not exist.');
				// Save this bad path. It can take too long to to a stat on every user entered character, but once a user enters a bad path they are likely
				// to keep typing more bad path. We can compare against this bad path and see if the user entered path starts with it.
				this.badPath = value;
				return UpdateResult.InvalidPath;
			} else {
				const inputUriDirname = resources.dirname(valueUri);
				if (!resources.isEqual(resources.removeTrailingPathSeparator(this.currentFolder), inputUriDirname, true)) {
					let statWithoutTrailing: IFileStat | undefined;
					try {
						statWithoutTrailing = await this.fileService.resolve(inputUriDirname);
					} catch (e) {
						// do nothing
					}
					if (statWithoutTrailing && statWithoutTrailing.isDirectory) {
						await this.updateItems(inputUriDirname, false, resources.basename(valueUri));
						this.badPath = undefined;
						return UpdateResult.Updated;
					}
				}
			}
		}
		this.badPath = undefined;
		return UpdateResult.NotUpdated;
	}

	private setActiveItems(value: string) {
		const inputBasename = resources.basename(this.remoteUriFrom(value));
		// Make sure that the folder whose children we are currently viewing matches the path in the input
		const userPath = this.constructFullUserPath();
		if (equalsIgnoreCase(userPath, value.substring(0, userPath.length))) {
			let hasMatch = false;
			if (inputBasename.length > this.userEnteredPathSegment.length) {
				for (let i = 0; i < this.filePickBox.items.length; i++) {
					const item = <FileQuickPickItem>this.filePickBox.items[i];
					if (this.setAutoComplete(value, inputBasename, item)) {
						hasMatch = true;
						break;
					}
				}
			}
			if (!hasMatch) {
				this.userEnteredPathSegment = inputBasename;
				this.autoCompletePathSegment = '';
				this.filePickBox.activeItems = [];
			}
		} else {
			this.userEnteredPathSegment = inputBasename;
			this.autoCompletePathSegment = '';
		}
	}

	private setAutoComplete(startingValue: string, startingBasename: string, quickPickItem: FileQuickPickItem, force: boolean = false): boolean {
		if (this.busy) {
			// We're in the middle of something else. Doing an auto complete now can result jumbled or incorrect autocompletes.
			this.userEnteredPathSegment = startingBasename;
			this.autoCompletePathSegment = '';
			return false;
		}
		const itemBasename = this.trimTrailingSlash(quickPickItem.label);
		// Either force the autocomplete, or the old value should be one smaller than the new value and match the new value.
		if (itemBasename === '..') {
			// Don't match on the up directory item ever.
			this.userEnteredPathSegment = startingValue;
			this.autoCompletePathSegment = '';
			this.activeItem = quickPickItem;
			if (force) {
				// clear any selected text
				this.insertText(this.userEnteredPathSegment, '');
			}
			return false;
		} else if (!force && (itemBasename.length >= startingBasename.length) && equalsIgnoreCase(itemBasename.substr(0, startingBasename.length), startingBasename)) {
			this.userEnteredPathSegment = startingBasename;
			this.activeItem = quickPickItem;
			// Changing the active items will trigger the onDidActiveItemsChanged. Clear the autocomplete first, then set it after.
			this.autoCompletePathSegment = '';
			this.filePickBox.activeItems = [quickPickItem];
			return true;
		} else if (force && (!equalsIgnoreCase(quickPickItem.label, (this.userEnteredPathSegment + this.autoCompletePathSegment)))) {
			this.userEnteredPathSegment = '';
			this.autoCompletePathSegment = this.trimTrailingSlash(itemBasename);
			this.activeItem = quickPickItem;
			this.filePickBox.valueSelection = [this.pathFromUri(this.currentFolder, true).length, this.filePickBox.value.length];
			// use insert text to preserve undo buffer
			this.insertText(this.pathAppend(this.currentFolder, this.autoCompletePathSegment), this.autoCompletePathSegment);
			this.filePickBox.valueSelection = [this.filePickBox.value.length - this.autoCompletePathSegment.length, this.filePickBox.value.length];
			return true;
		} else {
			this.userEnteredPathSegment = startingBasename;
			this.autoCompletePathSegment = '';
			return false;
		}
	}

	private insertText(wholeValue: string, insertText: string) {
		if (this.filePickBox.inputHasFocus()) {
			document.execCommand('insertText', false, insertText);
		} else {
			this.filePickBox.value = wholeValue;
		}
	}

	private addPostfix(uri: URI): URI {
		let result = uri;
		if (this.requiresTrailing && this.options.filters && this.options.filters.length > 0) {
			// Make sure that the suffix is added. If the user deleted it, we automatically add it here
			let hasExt: boolean = false;
			const currentExt = resources.extname(uri).substr(1);
			for (let i = 0; i < this.options.filters.length; i++) {
				for (let j = 0; j < this.options.filters[i].extensions.length; j++) {
					if ((this.options.filters[i].extensions[j] === '*') || (this.options.filters[i].extensions[j] === currentExt)) {
						hasExt = true;
						break;
					}
				}
				if (hasExt) {
					break;
				}
			}
			if (!hasExt) {
				result = resources.joinPath(resources.dirname(uri), resources.basename(uri) + '.' + this.options.filters[0].extensions[0]);
			}
		}
		return result;
	}

	private trimTrailingSlash(path: string): string {
		return ((path.length > 1) && this.endsWithSlash(path)) ? path.substr(0, path.length - 1) : path;
	}

	private yesNoPrompt(uri: URI, message: string): Promise<boolean> {
		interface YesNoItem extends IQuickPickItem {
			value: boolean;
		}
		const prompt = this.quickInputService.createQuickPick<YesNoItem>();
		prompt.title = message;
		prompt.ignoreFocusOut = true;
		prompt.ok = true;
		prompt.customButton = true;
		prompt.customLabel = nls.localize('remoteFileDialog.cancel', 'Cancel');
		prompt.value = this.pathFromUri(uri);

		let isResolving = false;
		return new Promise<boolean>(resolve => {
			prompt.onDidAccept(() => {
				isResolving = true;
				prompt.hide();
				resolve(true);
			});
			prompt.onDidHide(() => {
				if (!isResolving) {
					resolve(false);
				}
				this.filePickBox.show();
				this.hidden = false;
				this.filePickBox.items = this.filePickBox.items;
				prompt.dispose();
			});
			prompt.onDidChangeValue(() => {
				prompt.hide();
			});
			prompt.onDidCustom(() => {
				prompt.hide();
			});
			prompt.show();
		});
	}

	private async validate(uri: URI | undefined): Promise<boolean> {
		if (uri === undefined) {
			this.filePickBox.validationMessage = nls.localize('remoteFileDialog.invalidPath', 'Please enter a valid path.');
			return Promise.resolve(false);
		}

		let stat: IFileStat | undefined;
		let statDirname: IFileStat | undefined;
		try {
			statDirname = await this.fileService.resolve(resources.dirname(uri));
			stat = await this.fileService.resolve(uri);
		} catch (e) {
			// do nothing
		}

		if (this.requiresTrailing) { // save
			if (stat && stat.isDirectory) {
				// Can't do this
				this.filePickBox.validationMessage = nls.localize('remoteFileDialog.validateFolder', 'The folder already exists. Please use a new file name.');
				return Promise.resolve(false);
			} else if (stat) {
				// Replacing a file.
				// Show a yes/no prompt
				const message = nls.localize('remoteFileDialog.validateExisting', '{0} already exists. Are you sure you want to overwrite it?', resources.basename(uri));
				return this.yesNoPrompt(uri, message);
			} else if (!(isValidBasename(resources.basename(uri), await this.isWindowsOS()))) {
				// Filename not allowed
				this.filePickBox.validationMessage = nls.localize('remoteFileDialog.validateBadFilename', 'Please enter a valid file name.');
				return Promise.resolve(false);
			} else if (!statDirname || !statDirname.isDirectory) {
				// Folder to save in doesn't exist
				this.filePickBox.validationMessage = nls.localize('remoteFileDialog.validateNonexistentDir', 'Please enter a path that exists.');
				return Promise.resolve(false);
			}
		} else { // open
			if (!stat) {
				// File or folder doesn't exist
				this.filePickBox.validationMessage = nls.localize('remoteFileDialog.validateNonexistentDir', 'Please enter a path that exists.');
				return Promise.resolve(false);
			} else if (stat.isDirectory && !this.allowFolderSelection) {
				// Folder selected when folder selection not permitted
				this.filePickBox.validationMessage = nls.localize('remoteFileDialog.validateFileOnly', 'Please select a file.');
				return Promise.resolve(false);
			} else if (!stat.isDirectory && !this.allowFileSelection) {
				// File selected when file selection not permitted
				this.filePickBox.validationMessage = nls.localize('remoteFileDialog.validateFolderOnly', 'Please select a folder.');
				return Promise.resolve(false);
			}
		}
		return Promise.resolve(true);
	}

	private async updateItems(newFolder: URI, force: boolean = false, trailing?: string) {
		this.busy = true;
		this.userEnteredPathSegment = trailing ? trailing : '';
		this.autoCompletePathSegment = '';
		const newValue = trailing ? this.pathAppend(newFolder, trailing) : this.pathFromUri(newFolder, true);
		this.currentFolder = resources.addTrailingPathSeparator(newFolder, this.separator);
		return this.createItems(this.currentFolder).then(items => {
			this.filePickBox.items = items;
			if (this.allowFolderSelection) {
				this.filePickBox.activeItems = [];
			}
			// the user might have continued typing while we were updating. Only update the input box if it doesn't match the directory.
			if (!equalsIgnoreCase(this.filePickBox.value, newValue) && force) {
				this.filePickBox.valueSelection = [0, this.filePickBox.value.length];
				this.insertText(newValue, newValue);
			}
			if (force && trailing) {
				// Keep the cursor position in front of the save as name.
				this.filePickBox.valueSelection = [this.filePickBox.value.length - trailing.length, this.filePickBox.value.length - trailing.length];
			} else if (!trailing) {
				// If there is trailing, we don't move the cursor. If there is no trailing, cursor goes at the end.
				this.filePickBox.valueSelection = [this.filePickBox.value.length, this.filePickBox.value.length];
			}
			this.busy = false;
		});
	}

	private pathFromUri(uri: URI, endWithSeparator: boolean = false): string {
		let result: string = uri.fsPath.replace(/\n/g, '');
		if (this.separator === '/') {
			result = result.replace(/\\/g, this.separator);
		} else {
			result = result.replace(/\//g, this.separator);
		}
		if (endWithSeparator && !this.endsWithSlash(result)) {
			result = result + this.separator;
		}
		return result;
	}

	private pathAppend(uri: URI, additional: string): string {
		if ((additional === '..') || (additional === '.')) {
			const basePath = this.pathFromUri(uri);
			return basePath + this.separator + additional;
		} else {
			return this.pathFromUri(resources.joinPath(uri, additional));
		}
	}

	private async isWindowsOS(): Promise<boolean> {
		let isWindowsOS = isWindows;
		const env = await this.getRemoteAgentEnvironment();
		if (env) {
			isWindowsOS = env.os === OperatingSystem.Windows;
		}
		return isWindowsOS;
	}

	private endsWithSlash(s: string) {
		return /[\/\\]$/.test(s);
	}

	private basenameWithTrailingSlash(fullPath: URI): string {
		const child = this.pathFromUri(fullPath, true);
		const parent = this.pathFromUri(resources.dirname(fullPath), true);
		return child.substring(parent.length);
	}

	private createBackItem(currFolder: URI): FileQuickPickItem | null {
		const parentFolder = resources.dirname(currFolder)!;
		if (!resources.isEqual(currFolder, parentFolder, true)) {
			return { label: '..', uri: resources.addTrailingPathSeparator(parentFolder, this.separator), isFolder: true };
		}
		return null;
	}

	private async createItems(currentFolder: URI): Promise<FileQuickPickItem[]> {
		const result: FileQuickPickItem[] = [];

		const backDir = this.createBackItem(currentFolder);
		try {
			const folder = await this.fileService.resolve(currentFolder);
			const fileNames = folder.children ? folder.children.map(child => child.name) : [];
			const items = await Promise.all(fileNames.map(fileName => this.createItem(fileName, currentFolder)));
			for (let item of items) {
				if (item) {
					result.push(item);
				}
			}
		} catch (e) {
			// ignore
			console.log(e);
		}
		const sorted = result.sort((i1, i2) => {
			if (i1.isFolder !== i2.isFolder) {
				return i1.isFolder ? -1 : 1;
			}
			const trimmed1 = this.endsWithSlash(i1.label) ? i1.label.substr(0, i1.label.length - 1) : i1.label;
			const trimmed2 = this.endsWithSlash(i2.label) ? i2.label.substr(0, i2.label.length - 1) : i2.label;
			return trimmed1.localeCompare(trimmed2);
		});

		if (backDir) {
			sorted.unshift(backDir);
		}
		return sorted;
	}

	private filterFile(file: URI): boolean {
		if (this.options.filters) {
			const ext = resources.extname(file);
			for (let i = 0; i < this.options.filters.length; i++) {
				for (let j = 0; j < this.options.filters[i].extensions.length; j++) {
					if (ext === ('.' + this.options.filters[i].extensions[j])) {
						return true;
					}
				}
			}
			return false;
		}
		return true;
	}

	private async createItem(filename: string, parent: URI): Promise<FileQuickPickItem | undefined> {
		let fullPath = resources.joinPath(parent, filename);
		try {
			const stat = await this.fileService.resolve(fullPath);
			if (stat.isDirectory) {
				filename = this.basenameWithTrailingSlash(fullPath);
				fullPath = resources.addTrailingPathSeparator(fullPath, this.separator);
				return { label: filename, uri: fullPath, isFolder: true, iconClasses: getIconClasses(this.modelService, this.modeService, fullPath || undefined, FileKind.FOLDER) };
			} else if (!stat.isDirectory && this.allowFileSelection && this.filterFile(fullPath)) {
				return { label: filename, uri: fullPath, isFolder: false, iconClasses: getIconClasses(this.modelService, this.modeService, fullPath || undefined) };
			}
			return undefined;
		} catch (e) {
			return undefined;
		}
	}
}