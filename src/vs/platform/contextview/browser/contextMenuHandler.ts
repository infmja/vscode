/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'vs/css!./contextMenuHandler';

import { IDisposable, combinedDisposable } from 'vs/base/common/lifecycle';
import { ActionRunner, IRunEvent, WBActionExecutedEvent, WBActionExecutedClassification } from 'vs/base/common/actions';
import { Menu } from 'vs/base/browser/ui/menu/menu';
import { IContextViewService } from 'vs/platform/contextview/browser/contextView';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { INotificationService } from 'vs/platform/notification/common/notification';
import { IKeybindingService } from 'vs/platform/keybinding/common/keybinding';
import { IThemeService } from 'vs/platform/theme/common/themeService';
import { IContextMenuDelegate } from 'vs/base/browser/contextmenu';
import { EventType, $, removeNode } from 'vs/base/browser/dom';
import { attachMenuStyler } from 'vs/platform/theme/common/styler';
import { domEvent } from 'vs/base/browser/event';
import { StandardMouseEvent } from 'vs/base/browser/mouseEvent';

export interface IContextMenuHandlerOptions {
	blockMouse: boolean;
}

export class ContextMenuHandler {
	private focusToReturn: HTMLElement;
	private block: HTMLElement | null;
	private options: IContextMenuHandlerOptions = { blockMouse: true };

	constructor(
		private contextViewService: IContextViewService,
		private telemetryService: ITelemetryService,
		private notificationService: INotificationService,
		private keybindingService: IKeybindingService,
		private themeService: IThemeService
	) { }

	configure(options: IContextMenuHandlerOptions): void {
		this.options = options;
	}

	showContextMenu(delegate: IContextMenuDelegate): void {
		const actions = delegate.getActions();
		if (!actions.length) {
			return; // Don't render an empty context menu
		}

		this.focusToReturn = document.activeElement as HTMLElement;

		let menu: Menu | undefined;

		this.contextViewService.showContextView({
			getAnchor: () => delegate.getAnchor(),
			canRelayout: false,
			anchorAlignment: delegate.anchorAlignment,

			render: (container) => {
				let className = delegate.getMenuClassName ? delegate.getMenuClassName() : '';

				if (className) {
					container.className += ' ' + className;
				}

				// Render invisible div to block mouse interaction in the rest of the UI
				if (this.options.blockMouse) {
					this.block = container.appendChild($('.context-view-block'));
				}

				const menuDisposables: IDisposable[] = [];

				const actionRunner = delegate.actionRunner || new ActionRunner();
				actionRunner.onDidBeforeRun(this.onActionRun, this, menuDisposables);
				actionRunner.onDidRun(this.onDidActionRun, this, menuDisposables);
				menu = new Menu(container, actions, {
					actionViewItemProvider: delegate.getActionViewItem,
					context: delegate.getActionsContext ? delegate.getActionsContext() : null,
					actionRunner,
					getKeyBinding: delegate.getKeyBinding ? delegate.getKeyBinding : action => this.keybindingService.lookupKeybinding(action.id)
				});

				menuDisposables.push(attachMenuStyler(menu, this.themeService));

				menu.onDidCancel(() => this.contextViewService.hideContextView(true), null, menuDisposables);
				menu.onDidBlur(() => this.contextViewService.hideContextView(true), null, menuDisposables);
				domEvent(window, EventType.BLUR)(() => { this.contextViewService.hideContextView(true); }, null, menuDisposables);
				domEvent(window, EventType.MOUSE_DOWN)((e: MouseEvent) => {
					let event = new StandardMouseEvent(e);
					let element: HTMLElement | null = event.target;

					// Don't do anything as we are likely creating a context menu
					if (event.rightButton) {
						return;
					}

					while (element) {
						if (element === container) {
							return;
						}

						element = element.parentElement;
					}

					this.contextViewService.hideContextView(true);
				}, null, menuDisposables);

				return combinedDisposable(...menuDisposables, menu);
			},

			focus: () => {
				if (menu) {
					menu.focus(!!delegate.autoSelectFirstItem);
				}
			},

			onHide: (didCancel?: boolean) => {
				if (delegate.onHide) {
					delegate.onHide(!!didCancel);
				}

				if (this.block) {
					removeNode(this.block);
					this.block = null;
				}

				if (this.focusToReturn) {
					this.focusToReturn.focus();
				}
			}
		});
	}

	private onActionRun(e: IRunEvent): void {
		if (this.telemetryService) {
			this.telemetryService.publicLog2<WBActionExecutedEvent, WBActionExecutedClassification>('workbenchActionExecuted', { id: e.action.id, from: 'contextMenu' });
		}

		this.contextViewService.hideContextView(false);

		// Restore focus here
		if (this.focusToReturn) {
			this.focusToReturn.focus();
		}
	}

	private onDidActionRun(e: IRunEvent): void {
		if (e.error && this.notificationService) {
			this.notificationService.error(e.error);
		}
	}
}
