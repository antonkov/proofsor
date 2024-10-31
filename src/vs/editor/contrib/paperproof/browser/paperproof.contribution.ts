/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { IEditorContribution } from '../../../common/editorCommon.js';
import { Range } from '../../../common/core/range.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ICodeEditor, IViewZone, IContentWidget, IContentWidgetPosition, ContentWidgetPositionPreference, IActiveCodeEditor } from '../../../browser/editorBrowser.js';
import { EditorContributionInstantiation, registerEditorContribution } from '../../../browser/editorExtensions.js';
import { IModelDeltaDecoration, InjectedTextCursorStops, InjectedTextOptions, PositionAffinity, TrackedRangeStickiness } from '../../../common/model.js';
import { ILanguageFeaturesService } from '../../../common/services/languageFeatures.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { observableValue } from '../../../../base/common/observable.js';
import { ProofTreeProvider } from '../../../common/languages.js';
import { converter } from './converter.js';
import { ConvertedProofTree } from './types.js';
import { Constants } from '../../../../base/common/uint.js';
import './paperproof.css';

interface HypChip {
	lineNumber: number;
	name: string;
	hypothesis: string;
}

const getHypChips = (tree: ConvertedProofTree): HypChip[] => {
	const result: HypChip[] = [];
	for (const box of tree.boxes) {
		for (const hypLayer of box.hypLayers) {
			for (const hyp of hypLayer.hypNodes) {
				result.push({
					name: hyp.name ?? 'no name',
					lineNumber: hypLayer.lineNumber,
					hypothesis: hyp.text ?? 'no text',
				});
			}
		}
	}
	return result;
};

class GoalViewZone implements IViewZone {
	readonly suppressMouseDown: boolean;
	readonly domNode: HTMLElement;

	afterLineNumber: number;
	/**
	 * We want that this view zone, which reserves space for a goal appears
	 * as close as possible to the next line, so we use a very large value here.
	 */
	readonly afterColumn = Constants.MAX_SAFE_SMALL_INTEGER;
	heightInPx: number;

	private _lastHeight?: number;
	private readonly _onHeight: () => void;

	constructor(afterLineNumber: number, heightInPx: number, onHeight: () => void) {
		this.afterLineNumber = afterLineNumber;
		this.heightInPx = heightInPx;

		this._onHeight = onHeight;
		this.suppressMouseDown = true;
		this.domNode = document.createElement('div');
	}

	onComputedHeight(height: number): void {
		if (this._lastHeight === undefined) {
			this._lastHeight = height;
		} else if (this._lastHeight !== height) {
			this._lastHeight = height;
			this._onHeight();
		}
	}

	isVisible(): boolean {
		return this._lastHeight !== 0
			&& this.domNode.hasAttribute('monaco-visible-view-zone');
	}
}

interface ProofState {
	tree: ConvertedProofTree;
	goal: string;
	goals: { lineNumber: number; goal: string }[];
}

class GoalContentWidget implements IContentWidget {
	private static _idPool = 0;

	private readonly _id: string;
	readonly allowEditorOverflow: boolean = false;
	readonly suppressMouseDown: boolean = true;
	readonly domNode: HTMLElement;
	private _widgetPosition?: IContentWidgetPosition;

	constructor(private readonly _editor: IActiveCodeEditor, position: { lineNumber: number; column: number }, texts: string[]) {
		this.domNode = document.createElement('div');
		const container = dom.$('div', { class: 'paperproof-goal-container', style: `height: ${20 * texts.length}px` });

		for (const text of texts) {
			const goal = dom.$('div', undefined, text);
			goal.className = 'paperproof-goal';
			container.appendChild(goal);
		}
		dom.reset(this.domNode, container);

		this.updatePosition(position);

		this._id = `paperproof.goal-${(GoalContentWidget._idPool++)}`;
	}

	getId(): string {
		return this._id;
	}

	getDomNode(): HTMLElement {
		return this.domNode;
	}

	updatePosition(position: { lineNumber: number; column: number }): void {
		this._widgetPosition = {
			position,
			preference: [ContentWidgetPositionPreference.BELOW]
		};
	}

	getPosition(): IContentWidgetPosition | null {
		return this._widgetPosition ?? null;
	}
}

export class PaperproofDecorations extends Disposable implements IEditorContribution {
	static readonly ID: string = 'editor.contrib.paperproof';

	// Decoration ids contributed by paperproof
	private _decorationIds: string[] = [];
	private _viewZoneIds: string[] = [];
	private _contentWidgets: GoalContentWidget[] = [];


	private readonly _sessionDisposables = new DisposableStore();
	private readonly proofTreeProvider = observableValue<ProofTreeProvider | undefined>(this, undefined);

	constructor(
		private readonly editor: ICodeEditor,
		@ILogService private readonly log: ILogService,
		@ILanguageFeaturesService private readonly languageFeaturesService: ILanguageFeaturesService,
	) {
		super();

		this._register(this.languageFeaturesService.proofTreeProvider.onDidChange(async () => {
			// this.log.info('[dbg] Proof tree changed');
			const model = this.editor.getModel();
			if (!model) {
				return;
			}
			const providers = this.languageFeaturesService.proofTreeProvider.all(model);
			if (providers.length === 0) {
				this.proofTreeProvider.set(undefined, undefined);
			} else {
				this.proofTreeProvider.set(providers[0], undefined);
			}
			this._update();
		}));
		this.editor.onDidChangeCursorPosition(() => {
			this._updateDecorations();
		});
		this._register(this._sessionDisposables);
		this._register(this.editor.onDidChangeModel(() => this._update()));
		this._update();
	}

	private _update() {
		this._sessionDisposables.clear();
		this._removeAllDecorations();

		this._sessionDisposables.add(this.editor.onDidChangeModelContent(() => this._updateDecorations()));
		this._updateDecorations();
	}

	private async _getProofTree(): Promise<ProofState | undefined> {
		const model = this.editor.getModel();
		const provider = this.proofTreeProvider.get();
		const position = this.editor.getPosition();
		if (!model || !provider || !position) {
			return undefined;
		}
		const proofState = await provider.provideProofTree(model, position, CancellationToken.None);
		if (!proofState || !proofState.proofTree) {
			return undefined;
		}
		const goal = proofState.proofTree.flatMap(tactic => [tactic.goalBefore, ...tactic.goalsAfter]).find(g => g.id === proofState.goal?.mvarId);
		const handled = new Set<string>();
		const goals = proofState.proofTree.flatMap(tactic => {
			/*if (tactic.goalsAfter.length !== 1 || tactic.goalBefore.type !== tactic.goalsAfter[0].type) {
				// Goal changed, so we want to show it.
				return tactic.goalsAfter.map(g => ({ lineNumber: tactic.lineNumber, goal: g.type }));
			}
			return [];*/
			handled.add(tactic.goalBefore.id);
			return [{ lineNumber: tactic.lineNumber - 1, goal: tactic.goalBefore.type }];
		});
		const lastLineNumber = proofState.proofTree.length > 0 ? proofState.proofTree[proofState.proofTree.length - 1].lineNumber : 0;
		const moreGoals = proofState.proofTree.flatMap(tactic => tactic.goalsAfter.filter(g => !handled.has(g.id))).map(g => ({ lineNumber: lastLineNumber, goal: g.type }));
		// this.log.info(`[dbg] Goal: ${JSON.stringify(goal)}`);
		return { tree: converter(proofState.proofTree), goal: goal ? goal.type : 'no goal', goals: [...goals, ...moreGoals] };
	}

	private async _updateDecorations() {
		const model = this.editor.getModel();
		const provider = this.proofTreeProvider.get();
		const position = this.editor.getPosition();
		if (!model || !provider || !position) {
			return;
		}
		const proofState = await this._getProofTree();
		if (!proofState) {
			return;
		}
		const { tree, goal } = proofState;
		const hypChips = tree ? getHypChips(tree) : [];
		// this.log.info(`[dbg] Hypotheses: ${hypChips.map(h => `${h.lineNumber}: ${h.hypothesis}`).join('; ')}`);

		const createOptions = (content: string, inlineClassName: string) => {
			const nameOpts: InjectedTextOptions = {
				content,
				inlineClassNameAffectsLetterSpacing: true,
				inlineClassName,
				cursorStops: InjectedTextCursorStops.None,
			};

			const options = {
				description: 'Paperproof chip',
				showIfCollapsed: true,
				collapseOnReplaceEdit: true,
				stickiness: TrackedRangeStickiness.AlwaysGrowsWhenTypingAtEdges,
				after: nameOpts
			};
			return options;
		};

		this.editor.changeDecorations(accessor => {
			const oldDecorationIds = this._decorationIds;

			const decorations: IModelDeltaDecoration[] = [];
			for (const hypChip of hypChips) {
				if (hypChip.lineNumber === 0) {
					continue;
				}

				const range = new Range(hypChip.lineNumber, 0, hypChip.lineNumber, 100);

				decorations.push({ range, options: createOptions('  ', '') });
				decorations.push({ range, options: createOptions(`${hypChip.name}`, 'paperproof-hypothesis-name') });
				decorations.push({
					range, options: createOptions(`: ${hypChip.hypothesis}`, 'paperproof-hypothesis-type')
				});
			}

			const newDecorationIds = accessor.deltaDecorations(this._decorationIds, decorations);
			this._decorationIds = newDecorationIds;
			this.log.info(`Changing decorations. Old ids: ${oldDecorationIds.join(',')}`);
			this.log.info(`Changing decorations. New ids: ${newDecorationIds.join(',')}`);

			this.editor.changeViewZones(viewZonesAccessor => {
				// const cursorLineNumber = this.editor.getPosition()?.lineNumber ?? 0;
				for (const id of this._viewZoneIds) {
					viewZonesAccessor.removeZone(id);
				}
				this._viewZoneIds = [];
				for (const widget of this._contentWidgets) {
					this.editor.removeContentWidget(widget);
				}
				this._contentWidgets = [];
				// Group goals by line number
				const goalsByLineNumber = new Map<number, string[]>();
				for (const goal of proofState.goals) {
					goalsByLineNumber.set(goal.lineNumber, [...(goalsByLineNumber.get(goal.lineNumber) ?? []), goal.goal]);
				}
				for (const [lineNumber, goals] of goalsByLineNumber.entries()) {
					const goalViewZone = new GoalViewZone(lineNumber, 20 * goals.length, () => {
					});
					this._viewZoneIds.push(viewZonesAccessor.addZone(goalViewZone));

					// Here I want to determine what horizontal position to use for the goal.
					const prevLine = model.getLineContent(lineNumber);
					const nextLine = lineNumber + 1 < model.getLineCount() ? model.getLineContent(lineNumber + 1) : '';
					// Prefer to align with the next line, if it exists.
					const line = nextLine.trim().length > 0 ? nextLine : prevLine;
					// Find first non-whitespace character.
					// +1 because search returns 0-based index.
					const column = line.search(/\S/) + 1;

					this._contentWidgets.push(new GoalContentWidget(<IActiveCodeEditor>this.editor, { lineNumber, column }, goals));
					this.editor.addContentWidget(this._contentWidgets[this._contentWidgets.length - 1]);
				}
			});
		});
	}

	private _removeAllDecorations(): void {
		this.editor.removeDecorations(this._decorationIds);
		this._decorationIds = [];
		this.editor.changeViewZones(viewZonesAccessor => {
			for (const id of this._viewZoneIds) {
				viewZonesAccessor.removeZone(id);
			}
			this._viewZoneIds = [];
			for (const widget of this._contentWidgets) {
				this.editor.removeContentWidget(widget);
			}
			this._contentWidgets = [];
		});
	}
}

registerEditorContribution(PaperproofDecorations.ID, PaperproofDecorations, EditorContributionInstantiation.Eventually);
