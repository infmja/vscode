/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as nls from 'vs/nls';
import { RunOnceScheduler } from 'vs/base/common/async';
import { IAction, ActionRunner, WBActionExecutedEvent, WBActionExecutedClassification } from 'vs/base/common/actions';
import * as dom from 'vs/base/browser/dom';
import { IContextMenuService } from 'vs/platform/contextview/browser/contextView';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { IEditorGroupsService, IEditorGroup, GroupChangeKind, GroupsOrder } from 'vs/workbench/services/editor/common/editorGroupsService';
import { IConfigurationService, IConfigurationChangeEvent } from 'vs/platform/configuration/common/configuration';
import { IKeybindingService } from 'vs/platform/keybinding/common/keybinding';
import { IEditorInput } from 'vs/workbench/common/editor';
import { SaveAllAction, SaveAllInGroupAction, CloseGroupAction } from 'vs/workbench/contrib/files/browser/fileActions';
import { OpenEditorsFocusedContext, ExplorerFocusedContext, IFilesConfiguration, OpenEditor } from 'vs/workbench/contrib/files/common/files';
import { ITextFileService, AutoSaveMode } from 'vs/workbench/services/textfile/common/textfiles';
import { IUntitledEditorService } from 'vs/workbench/services/untitled/common/untitledEditorService';
import { CloseAllEditorsAction, CloseEditorAction } from 'vs/workbench/browser/parts/editor/editorActions';
import { ToggleEditorLayoutAction } from 'vs/workbench/browser/actions/layoutActions';
import { IContextKeyService, IContextKey } from 'vs/platform/contextkey/common/contextkey';
import { attachStylerCallback } from 'vs/platform/theme/common/styler';
import { IThemeService } from 'vs/platform/theme/common/themeService';
import { badgeBackground, badgeForeground, contrastBorder } from 'vs/platform/theme/common/colorRegistry';
import { WorkbenchList } from 'vs/platform/list/browser/listService';
import { IListVirtualDelegate, IListRenderer, IListContextMenuEvent, IListDragAndDrop, IListDragOverReaction } from 'vs/base/browser/ui/list/list';
import { ResourceLabels, IResourceLabel } from 'vs/workbench/browser/labels';
import { ActionBar } from 'vs/base/browser/ui/actionbar/actionbar';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { IEditorService, SIDE_GROUP, ACTIVE_GROUP } from 'vs/workbench/services/editor/common/editorService';
import { IDisposable, dispose } from 'vs/base/common/lifecycle';
import { createAndFillInContextMenuActions } from 'vs/platform/actions/browser/menuEntryActionViewItem';
import { IMenuService, MenuId, IMenu } from 'vs/platform/actions/common/actions';
import { DirtyEditorContext, OpenEditorsGroupContext } from 'vs/workbench/contrib/files/browser/fileCommands';
import { ResourceContextKey } from 'vs/workbench/common/resources';
import { ResourcesDropHandler, fillResourceDataTransfers, CodeDataTransfers } from 'vs/workbench/browser/dnd';
import { ViewletPanel, IViewletPanelOptions } from 'vs/workbench/browser/parts/views/panelViewlet';
import { IViewletViewOptions } from 'vs/workbench/browser/parts/views/viewsViewlet';
import { IDragAndDropData, DataTransfers } from 'vs/base/browser/dnd';
import { memoize } from 'vs/base/common/decorators';
import { ElementsDragAndDropData, DesktopDragAndDropData } from 'vs/base/browser/ui/list/listView';
import { URI } from 'vs/base/common/uri';
import { withNullAsUndefined, withUndefinedAsNull } from 'vs/base/common/types';

const $ = dom.$;

export class OpenEditorsView extends ViewletPanel {

	private static readonly DEFAULT_VISIBLE_OPEN_EDITORS = 9;
	static readonly ID = 'workbench.explorer.openEditorsView';
	static NAME = nls.localize({ key: 'openEditors', comment: ['Open is an adjective'] }, "Open Editors");

	private dirtyCountElement: HTMLElement;
	private listRefreshScheduler: RunOnceScheduler;
	private structuralRefreshDelay: number;
	private list: WorkbenchList<OpenEditor | IEditorGroup>;
	private listLabels: ResourceLabels;
	private contributedContextMenu: IMenu;
	private needsRefresh: boolean;
	private resourceContext: ResourceContextKey;
	private groupFocusedContext: IContextKey<boolean>;
	private dirtyEditorFocusedContext: IContextKey<boolean>;

	constructor(
		options: IViewletViewOptions,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@ITextFileService private readonly textFileService: ITextFileService,
		@IEditorService private readonly editorService: IEditorService,
		@IEditorGroupsService private readonly editorGroupService: IEditorGroupsService,
		@IConfigurationService configurationService: IConfigurationService,
		@IKeybindingService keybindingService: IKeybindingService,
		@IUntitledEditorService private readonly untitledEditorService: IUntitledEditorService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IThemeService private readonly themeService: IThemeService,
		@ITelemetryService private readonly telemetryService: ITelemetryService,
		@IMenuService private readonly menuService: IMenuService
	) {
		super({
			...(options as IViewletPanelOptions),
			ariaHeaderLabel: nls.localize({ key: 'openEditosrSection', comment: ['Open is an adjective'] }, "Open Editors Section"),
		}, keybindingService, contextMenuService, configurationService);

		this.structuralRefreshDelay = 0;
		this.listRefreshScheduler = new RunOnceScheduler(() => {
			const previousLength = this.list.length;
			this.list.splice(0, this.list.length, this.elements);
			this.focusActiveEditor();
			if (previousLength !== this.list.length) {
				this.updateSize();
			}
			this.needsRefresh = false;
		}, this.structuralRefreshDelay);

		this.registerUpdateEvents();

		// Also handle configuration updates
		this._register(this.configurationService.onDidChangeConfiguration(e => this.onConfigurationChange(e)));

		// Handle dirty counter
		this._register(this.untitledEditorService.onDidChangeDirty(() => this.updateDirtyIndicator()));
		this._register(this.textFileService.models.onModelsDirty(() => this.updateDirtyIndicator()));
		this._register(this.textFileService.models.onModelsSaved(() => this.updateDirtyIndicator()));
		this._register(this.textFileService.models.onModelsSaveError(() => this.updateDirtyIndicator()));
		this._register(this.textFileService.models.onModelsReverted(() => this.updateDirtyIndicator()));
	}

	private registerUpdateEvents(): void {
		const updateWholeList = () => {
			if (!this.isBodyVisible() || !this.list) {
				this.needsRefresh = true;
				return;
			}

			this.listRefreshScheduler.schedule(this.structuralRefreshDelay);
		};

		const groupDisposables = new Map<number, IDisposable>();
		const addGroupListener = (group: IEditorGroup) => {
			groupDisposables.set(group.id, group.onDidGroupChange(e => {
				if (this.listRefreshScheduler.isScheduled()) {
					return;
				}
				if (!this.isBodyVisible() || !this.list) {
					this.needsRefresh = true;
					return;
				}

				const index = this.getIndex(group, e.editor);
				switch (e.kind) {
					case GroupChangeKind.GROUP_LABEL: {
						if (this.showGroups) {
							this.list.splice(index, 1, [group]);
						}
						break;
					}
					case GroupChangeKind.GROUP_ACTIVE:
					case GroupChangeKind.EDITOR_ACTIVE: {
						this.focusActiveEditor();
						break;
					}
					case GroupChangeKind.EDITOR_DIRTY:
					case GroupChangeKind.EDITOR_LABEL:
					case GroupChangeKind.EDITOR_PIN: {
						this.list.splice(index, 1, [new OpenEditor(e.editor!, group)]);
						break;
					}
					case GroupChangeKind.EDITOR_OPEN: {
						this.list.splice(index, 0, [new OpenEditor(e.editor!, group)]);
						setTimeout(() => this.updateSize(), this.structuralRefreshDelay);
						break;
					}
					case GroupChangeKind.EDITOR_CLOSE: {
						const previousIndex = this.getIndex(group, undefined) + (e.editorIndex || 0) + (this.showGroups ? 1 : 0);
						this.list.splice(previousIndex, 1);
						this.updateSize();
						break;
					}
					case GroupChangeKind.EDITOR_MOVE: {
						this.listRefreshScheduler.schedule();
						break;
					}
				}
			}));
			this._register(groupDisposables.get(group.id)!);
		};

		this.editorGroupService.groups.forEach(g => addGroupListener(g));
		this._register(this.editorGroupService.onDidAddGroup(group => {
			addGroupListener(group);
			updateWholeList();
		}));
		this._register(this.editorGroupService.onDidMoveGroup(() => updateWholeList()));
		this._register(this.editorGroupService.onDidRemoveGroup(group => {
			dispose(groupDisposables.get(group.id));
			updateWholeList();
		}));
	}

	protected renderHeaderTitle(container: HTMLElement): void {
		super.renderHeaderTitle(container, this.title);

		const count = dom.append(container, $('.count'));
		this.dirtyCountElement = dom.append(count, $('.monaco-count-badge'));

		this._register((attachStylerCallback(this.themeService, { badgeBackground, badgeForeground, contrastBorder }, colors => {
			const background = colors.badgeBackground ? colors.badgeBackground.toString() : null;
			const foreground = colors.badgeForeground ? colors.badgeForeground.toString() : null;
			const border = colors.contrastBorder ? colors.contrastBorder.toString() : null;

			this.dirtyCountElement.style.backgroundColor = background;
			this.dirtyCountElement.style.color = foreground;

			this.dirtyCountElement.style.borderWidth = border ? '1px' : null;
			this.dirtyCountElement.style.borderStyle = border ? 'solid' : null;
			this.dirtyCountElement.style.borderColor = border;
		})));

		this.updateDirtyIndicator();
	}

	public renderBody(container: HTMLElement): void {
		dom.addClass(container, 'explorer-open-editors');
		dom.addClass(container, 'show-file-icons');

		const delegate = new OpenEditorsDelegate();

		if (this.list) {
			this.list.dispose();
		}
		if (this.listLabels) {
			this.listLabels.clear();
		}
		this.listLabels = this.instantiationService.createInstance(ResourceLabels, { onDidChangeVisibility: this.onDidChangeBodyVisibility });
		this.list = this.instantiationService.createInstance(WorkbenchList, container, delegate, [
			new EditorGroupRenderer(this.keybindingService, this.instantiationService),
			new OpenEditorRenderer(this.listLabels, this.instantiationService, this.keybindingService, this.configurationService)
		], {
				identityProvider: { getId: (element: OpenEditor | IEditorGroup) => element instanceof OpenEditor ? element.getId() : element.id.toString() },
				dnd: new OpenEditorsDragAndDrop(this.instantiationService, this.editorGroupService)
			}) as WorkbenchList<OpenEditor | IEditorGroup>;
		this._register(this.list);
		this._register(this.listLabels);

		this.contributedContextMenu = this.menuService.createMenu(MenuId.OpenEditorsContext, this.list.contextKeyService);
		this._register(this.contributedContextMenu);

		this.updateSize();

		// Bind context keys
		OpenEditorsFocusedContext.bindTo(this.list.contextKeyService);
		ExplorerFocusedContext.bindTo(this.list.contextKeyService);

		this.resourceContext = this.instantiationService.createInstance(ResourceContextKey);
		this._register(this.resourceContext);
		this.groupFocusedContext = OpenEditorsGroupContext.bindTo(this.contextKeyService);
		this.dirtyEditorFocusedContext = DirtyEditorContext.bindTo(this.contextKeyService);

		this._register(this.list.onContextMenu(e => this.onListContextMenu(e)));
		this.list.onFocusChange(e => {
			this.resourceContext.reset();
			this.groupFocusedContext.reset();
			this.dirtyEditorFocusedContext.reset();
			const element = e.elements.length ? e.elements[0] : undefined;
			if (element instanceof OpenEditor) {
				this.dirtyEditorFocusedContext.set(this.textFileService.isDirty(withNullAsUndefined(element.getResource())));
				this.resourceContext.set(withUndefinedAsNull(element.getResource()));
			} else if (!!element) {
				this.groupFocusedContext.set(true);
			}
		});

		// Open when selecting via keyboard
		this._register(this.list.onMouseMiddleClick(e => {
			if (e && e.element instanceof OpenEditor) {
				e.element.group.closeEditor(e.element.editor, { preserveFocus: true });
			}
		}));
		this._register(this.list.onDidOpen(e => {
			const browserEvent = e.browserEvent;

			let openToSide = false;
			let isSingleClick = false;
			let isDoubleClick = false;
			if (browserEvent instanceof MouseEvent) {
				isSingleClick = browserEvent.detail === 1;
				isDoubleClick = browserEvent.detail === 2;
				openToSide = this.list.useAltAsMultipleSelectionModifier ? (browserEvent.ctrlKey || browserEvent.metaKey) : browserEvent.altKey;
			}

			const focused = this.list.getFocusedElements();
			const element = focused.length ? focused[0] : undefined;
			if (element instanceof OpenEditor) {
				this.openEditor(element, { preserveFocus: isSingleClick, pinned: isDoubleClick, sideBySide: openToSide });
			} else if (element) {
				this.editorGroupService.activateGroup(element);
			}
		}));

		this.listRefreshScheduler.schedule(0);

		this._register(this.onDidChangeBodyVisibility(visible => {
			if (visible && this.needsRefresh) {
				this.listRefreshScheduler.schedule(0);
			}
		}));
	}

	public getActions(): IAction[] {
		return [
			this.instantiationService.createInstance(ToggleEditorLayoutAction, ToggleEditorLayoutAction.ID, ToggleEditorLayoutAction.LABEL),
			this.instantiationService.createInstance(SaveAllAction, SaveAllAction.ID, SaveAllAction.LABEL),
			this.instantiationService.createInstance(CloseAllEditorsAction, CloseAllEditorsAction.ID, CloseAllEditorsAction.LABEL)
		];
	}

	public focus(): void {
		super.focus();
		this.list.domFocus();
	}

	public getList(): WorkbenchList<OpenEditor | IEditorGroup> {
		return this.list;
	}

	protected layoutBody(height: number, width: number): void {
		if (this.list) {
			this.list.layout(height, width);
		}
	}

	private get showGroups(): boolean {
		return this.editorGroupService.groups.length > 1;
	}

	private get elements(): Array<IEditorGroup | OpenEditor> {
		const result: Array<IEditorGroup | OpenEditor> = [];
		this.editorGroupService.getGroups(GroupsOrder.GRID_APPEARANCE).forEach(g => {
			if (this.showGroups) {
				result.push(g);
			}
			result.push(...g.editors.map(ei => new OpenEditor(ei, g)));
		});

		return result;
	}

	private getIndex(group: IEditorGroup, editor: IEditorInput | undefined | null): number {
		let index = editor ? group.getIndexOfEditor(editor) : 0;
		if (!this.showGroups) {
			return index;
		}

		for (let g of this.editorGroupService.getGroups(GroupsOrder.GRID_APPEARANCE)) {
			if (g.id === group.id) {
				return index + (!!editor ? 1 : 0);
			} else {
				index += g.count + 1;
			}
		}

		return -1;
	}

	private openEditor(element: OpenEditor, options: { preserveFocus: boolean; pinned: boolean; sideBySide: boolean; }): void {
		if (element) {
			this.telemetryService.publicLog2<WBActionExecutedEvent, WBActionExecutedClassification>('workbenchActionExecuted', { id: 'workbench.files.openFile', from: 'openEditors' });

			const preserveActivateGroup = options.sideBySide && options.preserveFocus; // needed for https://github.com/Microsoft/vscode/issues/42399
			if (!preserveActivateGroup) {
				this.editorGroupService.activateGroup(element.groupId); // needed for https://github.com/Microsoft/vscode/issues/6672
			}
			this.editorService.openEditor(element.editor, options, options.sideBySide ? SIDE_GROUP : ACTIVE_GROUP).then(editor => {
				if (editor && !preserveActivateGroup && editor.group) {
					this.editorGroupService.activateGroup(editor.group);
				}
			});
		}
	}

	private onListContextMenu(e: IListContextMenuEvent<OpenEditor | IEditorGroup>): void {
		if (!e.element) {
			return;
		}

		const element = e.element;
		const actions: IAction[] = [];
		const actionsDisposable = createAndFillInContextMenuActions(this.contributedContextMenu, { shouldForwardArgs: true, arg: element instanceof OpenEditor ? element.editor.getResource() : {} }, actions, this.contextMenuService);

		this.contextMenuService.showContextMenu({
			getAnchor: () => e.anchor,
			getActions: () => actions,
			getActionsContext: () => element instanceof OpenEditor ? { groupId: element.groupId, editorIndex: element.editorIndex } : { groupId: element.id },
			onHide: () => dispose(actionsDisposable)
		});
	}

	private focusActiveEditor(): void {
		if (this.list.length && this.editorGroupService.activeGroup) {
			const index = this.getIndex(this.editorGroupService.activeGroup, this.editorGroupService.activeGroup.activeEditor);
			this.list.setFocus([index]);
			this.list.setSelection([index]);
			this.list.reveal(index);
		} else {
			this.list.setFocus([]);
			this.list.setSelection([]);
		}
	}

	private onConfigurationChange(event: IConfigurationChangeEvent): void {
		if (event.affectsConfiguration('explorer.openEditors')) {
			this.updateSize();
		}

		// Trigger a 'repaint' when decoration settings change
		if (event.affectsConfiguration('explorer.decorations')) {
			this.listRefreshScheduler.schedule();
		}
	}

	private updateSize(): void {
		// Adjust expanded body size
		this.minimumBodySize = this.getMinExpandedBodySize();
		this.maximumBodySize = this.getMaxExpandedBodySize();
	}

	private updateDirtyIndicator(): void {
		let dirty = this.textFileService.getAutoSaveMode() !== AutoSaveMode.AFTER_SHORT_DELAY ? this.textFileService.getDirty().length
			: this.untitledEditorService.getDirty().length;
		if (dirty === 0) {
			dom.addClass(this.dirtyCountElement, 'hidden');
		} else {
			this.dirtyCountElement.textContent = nls.localize('dirtyCounter', "{0} unsaved", dirty);
			dom.removeClass(this.dirtyCountElement, 'hidden');
		}
	}

	private get elementCount(): number {
		return this.editorGroupService.groups.map(g => g.count)
			.reduce((first, second) => first + second, this.showGroups ? this.editorGroupService.groups.length : 0);
	}

	private getMaxExpandedBodySize(): number {
		return this.elementCount * OpenEditorsDelegate.ITEM_HEIGHT;
	}

	private getMinExpandedBodySize(): number {
		let visibleOpenEditors = this.configurationService.getValue<number>('explorer.openEditors.visible');
		if (typeof visibleOpenEditors !== 'number') {
			visibleOpenEditors = OpenEditorsView.DEFAULT_VISIBLE_OPEN_EDITORS;
		}

		return this.computeMinExpandedBodySize(visibleOpenEditors);
	}

	private computeMinExpandedBodySize(visibleOpenEditors = OpenEditorsView.DEFAULT_VISIBLE_OPEN_EDITORS): number {
		const itemsToShow = Math.min(Math.max(visibleOpenEditors, 1), this.elementCount);
		return itemsToShow * OpenEditorsDelegate.ITEM_HEIGHT;
	}

	public setStructuralRefreshDelay(delay: number): void {
		this.structuralRefreshDelay = delay;
	}

	public getOptimalWidth(): number {
		let parentNode = this.list.getHTMLElement();
		let childNodes: HTMLElement[] = [].slice.call(parentNode.querySelectorAll('.open-editor > a'));

		return dom.getLargestChildWidth(parentNode, childNodes);
	}
}

interface IOpenEditorTemplateData {
	container: HTMLElement;
	root: IResourceLabel;
	actionBar: ActionBar;
	actionRunner: OpenEditorActionRunner;
}

interface IEditorGroupTemplateData {
	root: HTMLElement;
	name: HTMLSpanElement;
	actionBar: ActionBar;
	editorGroup: IEditorGroup;
}

class OpenEditorActionRunner extends ActionRunner {
	public editor: OpenEditor;

	run(action: IAction, context?: any): Promise<void> {
		return super.run(action, { groupId: this.editor.groupId, editorIndex: this.editor.editorIndex });
	}
}

class OpenEditorsDelegate implements IListVirtualDelegate<OpenEditor | IEditorGroup> {

	public static readonly ITEM_HEIGHT = 22;

	getHeight(element: OpenEditor | IEditorGroup): number {
		return OpenEditorsDelegate.ITEM_HEIGHT;
	}

	getTemplateId(element: OpenEditor | IEditorGroup): string {
		if (element instanceof OpenEditor) {
			return OpenEditorRenderer.ID;
		}

		return EditorGroupRenderer.ID;
	}
}

class EditorGroupRenderer implements IListRenderer<IEditorGroup, IEditorGroupTemplateData> {
	static readonly ID = 'editorgroup';

	constructor(
		private keybindingService: IKeybindingService,
		private instantiationService: IInstantiationService,
	) {
		// noop
	}

	get templateId() {
		return EditorGroupRenderer.ID;
	}

	renderTemplate(container: HTMLElement): IEditorGroupTemplateData {
		const editorGroupTemplate: IEditorGroupTemplateData = Object.create(null);
		editorGroupTemplate.root = dom.append(container, $('.editor-group'));
		editorGroupTemplate.name = dom.append(editorGroupTemplate.root, $('span.name'));
		editorGroupTemplate.actionBar = new ActionBar(container);

		const saveAllInGroupAction = this.instantiationService.createInstance(SaveAllInGroupAction, SaveAllInGroupAction.ID, SaveAllInGroupAction.LABEL);
		const saveAllInGroupKey = this.keybindingService.lookupKeybinding(saveAllInGroupAction.id);
		editorGroupTemplate.actionBar.push(saveAllInGroupAction, { icon: true, label: false, keybinding: saveAllInGroupKey ? saveAllInGroupKey.getLabel() : undefined });

		const closeGroupAction = this.instantiationService.createInstance(CloseGroupAction, CloseGroupAction.ID, CloseGroupAction.LABEL);
		const closeGroupActionKey = this.keybindingService.lookupKeybinding(closeGroupAction.id);
		editorGroupTemplate.actionBar.push(closeGroupAction, { icon: true, label: false, keybinding: closeGroupActionKey ? closeGroupActionKey.getLabel() : undefined });

		return editorGroupTemplate;
	}

	renderElement(editorGroup: IEditorGroup, index: number, templateData: IEditorGroupTemplateData): void {
		templateData.editorGroup = editorGroup;
		templateData.name.textContent = editorGroup.label;
		templateData.actionBar.context = { groupId: editorGroup.id };
	}

	disposeTemplate(templateData: IEditorGroupTemplateData): void {
		templateData.actionBar.dispose();
	}
}

class OpenEditorRenderer implements IListRenderer<OpenEditor, IOpenEditorTemplateData> {
	static readonly ID = 'openeditor';

	constructor(
		private labels: ResourceLabels,
		private instantiationService: IInstantiationService,
		private keybindingService: IKeybindingService,
		private configurationService: IConfigurationService
	) {
		// noop
	}

	get templateId() {
		return OpenEditorRenderer.ID;
	}

	renderTemplate(container: HTMLElement): IOpenEditorTemplateData {
		const editorTemplate: IOpenEditorTemplateData = Object.create(null);
		editorTemplate.container = container;
		editorTemplate.actionRunner = new OpenEditorActionRunner();
		editorTemplate.actionBar = new ActionBar(container, { actionRunner: editorTemplate.actionRunner });
		container.draggable = true;

		const closeEditorAction = this.instantiationService.createInstance(CloseEditorAction, CloseEditorAction.ID, CloseEditorAction.LABEL);
		const key = this.keybindingService.lookupKeybinding(closeEditorAction.id);
		editorTemplate.actionBar.push(closeEditorAction, { icon: true, label: false, keybinding: key ? key.getLabel() : undefined });

		editorTemplate.root = this.labels.create(container);

		return editorTemplate;
	}

	renderElement(editor: OpenEditor, index: number, templateData: IOpenEditorTemplateData): void {
		templateData.actionRunner.editor = editor;
		editor.isDirty() ? dom.addClass(templateData.container, 'dirty') : dom.removeClass(templateData.container, 'dirty');
		templateData.root.setEditor(editor.editor, {
			italic: editor.isPreview(),
			extraClasses: ['open-editor'],
			fileDecorations: this.configurationService.getValue<IFilesConfiguration>().explorer.decorations
		});
	}

	disposeTemplate(templateData: IOpenEditorTemplateData): void {
		templateData.actionBar.dispose();
		templateData.root.dispose();
		templateData.actionRunner.dispose();
	}
}

class OpenEditorsDragAndDrop implements IListDragAndDrop<OpenEditor | IEditorGroup> {

	constructor(
		private instantiationService: IInstantiationService,
		private editorGroupService: IEditorGroupsService
	) { }

	@memoize private get dropHandler(): ResourcesDropHandler {
		return this.instantiationService.createInstance(ResourcesDropHandler, { allowWorkspaceOpen: false });
	}

	getDragURI(element: OpenEditor | IEditorGroup): string | null {
		if (element instanceof OpenEditor) {
			const resource = element.getResource();
			if (resource) {
				return resource.toString();
			}
		}
		return null;
	}

	getDragLabel?(elements: (OpenEditor | IEditorGroup)[]): string | undefined {
		if (elements.length > 1) {
			return String(elements.length);
		}
		const element = elements[0];

		return element instanceof OpenEditor ? withNullAsUndefined(element.editor.getName()) : element.label;
	}

	onDragStart(data: IDragAndDropData, originalEvent: DragEvent): void {
		const items = (data as ElementsDragAndDropData<OpenEditor | IEditorGroup>).elements;
		const resources: URI[] = [];
		if (items) {
			items.forEach(i => {
				if (i instanceof OpenEditor) {
					const resource = i.getResource();
					if (resource) {
						resources.push(resource);
					}
				}
			});
		}

		if (resources.length) {
			// Apply some datatransfer types to allow for dragging the element outside of the application
			this.instantiationService.invokeFunction(fillResourceDataTransfers, resources, originalEvent);
		}
	}

	onDragOver(data: IDragAndDropData, targetElement: OpenEditor | IEditorGroup, targetIndex: number, originalEvent: DragEvent): boolean | IListDragOverReaction {
		if (data instanceof DesktopDragAndDropData && originalEvent.dataTransfer) {
			const types = originalEvent.dataTransfer.types;
			const typesArray: string[] = [];
			for (let i = 0; i < types.length; i++) {
				typesArray.push(types[i].toLowerCase()); // somehow the types are lowercase
			}

			if (typesArray.indexOf(DataTransfers.FILES.toLowerCase()) === -1 && typesArray.indexOf(CodeDataTransfers.FILES.toLowerCase()) === -1) {
				return false;
			}
		}

		return true;
	}

	drop(data: IDragAndDropData, targetElement: OpenEditor | IEditorGroup, targetIndex: number, originalEvent: DragEvent): void {
		const group = targetElement instanceof OpenEditor ? targetElement.group : targetElement;
		const index = targetElement instanceof OpenEditor ? targetElement.group.getIndexOfEditor(targetElement.editor) : 0;

		if (data instanceof ElementsDragAndDropData) {
			const elementsData = data.elements;
			elementsData.forEach((oe, offset) => {
				oe.group.moveEditor(oe.editor, group, { index: index + offset, preserveFocus: true });
			});
			this.editorGroupService.activateGroup(group);
		} else {
			this.dropHandler.handleDrop(originalEvent, () => group, () => group.focus(), index);
		}
	}
}
