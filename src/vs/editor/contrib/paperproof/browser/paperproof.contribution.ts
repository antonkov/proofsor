/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { IEditorContribution } from '../../../common/editorCommon.js';
import { Range } from '../../../common/core/range.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ICodeEditor } from '../../../browser/editorBrowser.js';
import { EditorContributionInstantiation, registerEditorContribution } from '../../../browser/editorExtensions.js';
import { IModelDeltaDecoration, InjectedTextCursorStops, InjectedTextOptions, TrackedRangeStickiness } from '../../../common/model.js';
import { ILanguageFeaturesService } from '../../../common/services/languageFeatures.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { observableValue } from '../../../../base/common/observable.js';
import { ProofTreeProvider } from '../../../common/languages.js';
import { converter } from './converter.js';
import { ConvertedProofTree } from './types.js';
import { ClassNameReference, DynamicCssRules } from '../../../browser/editorDom.js';
import { EditorOption } from '../../../common/config/editorOptions.js';

interface HypChip {
	lineNumber: number;
	hypothesis: string;
}

const getHypChips = (tree: ConvertedProofTree): HypChip[] => {
	const result: HypChip[] = [];
	for (const box of tree.boxes) {
		for (const hypLayer of box.hypLayers) {
			for (const hyp of hypLayer.hypNodes) {
				result.push({
					lineNumber: hypLayer.lineNumber,
					hypothesis: hyp.text ?? 'no text',
				});
			}
		}
	}
	return result;
};

export class PaperproofDecorations extends Disposable implements IEditorContribution {
	static readonly ID: string = 'editor.contrib.paperproof';

	// Decoration ids contributed by paperproof
	private _decorationIds: string[] = [];

	private readonly _sessionDisposables = new DisposableStore();
	private readonly proofTreeProvider = observableValue<ProofTreeProvider | undefined>(this, undefined);
	private readonly _ruleFactory = new DynamicCssRules(this.editor);
	private _chipRule: ClassNameReference;

	constructor(
		private readonly editor: ICodeEditor,
		@ILogService private readonly log: ILogService,
		@ILanguageFeaturesService private readonly languageFeaturesService: ILanguageFeaturesService,
	) {
		super();

		const editorFontSize = this.editor.getOption(EditorOption.fontSize);
		this._chipRule = this._ruleFactory.createClassNameRef({
			backgroundColor: '#a4dabc',
			color: '#3a505a',
			border: '2px solid rgb(152 214 179)',
			height: '12px',
			padding: '0 4px',
			margin: '0 0 0 16px',
			display: 'inline-block'
		});



		this._register(this.languageFeaturesService.proofTreeProvider.onDidChange(async () => {
			this.log.info('[dbg] Proof tree changed');
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

	private async _getProofTree(): Promise<ConvertedProofTree | undefined> {
		const model = this.editor.getModel();
		const provider = this.proofTreeProvider.get();
		const position = this.editor.getPosition();
		if (!model || !provider || !position) {
			return undefined;
		}
		const leanProofTree = await provider.provideProofTree(model, position, CancellationToken.None);
		if (!leanProofTree) {
			return undefined;
		}
		return converter(leanProofTree);
	}

	private async _updateDecorations() {
		const model = this.editor.getModel();
		const provider = this.proofTreeProvider.get();
		const position = this.editor.getPosition();
		if (!model || !provider || !position) {
			return;
		}
		const tree = await this._getProofTree();
		const hypChips = tree ? getHypChips(tree) : [];
		this.log.info(`[dbg] Hypotheses: ${hypChips.map(h => `${h.lineNumber}: ${h.hypothesis}`).join('; ')}`);

		this.editor.changeDecorations(accessor => {
			const oldDecorationIds = this._decorationIds;
			const model = this.editor.getModel();

			const decorations: IModelDeltaDecoration[] = [];
			for (const hypChip of hypChips) {
				if (hypChip.lineNumber === 0) {
					continue;
				}
				const opts: InjectedTextOptions = {
					content: `${hypChip.hypothesis}`,
					inlineClassNameAffectsLetterSpacing: true,
					inlineClassName: this._chipRule.className,
					cursorStops: InjectedTextCursorStops.None,
				};

				const options = {
					description: 'Paperproof chip',
					showIfCollapsed: true,
					collapseOnReplaceEdit: true,
					stickiness: TrackedRangeStickiness.AlwaysGrowsWhenTypingAtEdges,
					after: opts
				};

				const range = new Range(hypChip.lineNumber, 0, hypChip.lineNumber, 100);
				decorations.push({ range, options });
			}
			const newDecorationIds = accessor.deltaDecorations(this._decorationIds, decorations);
			this._decorationIds = newDecorationIds;
			this.log.info(`Changing decorations. Old ids: ${oldDecorationIds.join(',')}`);
			this.log.info(`Changing decorations. New ids: ${newDecorationIds.join(',')}`);
		});
	}

	private _removeAllDecorations(): void {
		this.editor.removeDecorations(this._decorationIds);
		this._decorationIds = [];
	}
}

registerEditorContribution(PaperproofDecorations.ID, PaperproofDecorations, EditorContributionInstantiation.Eventually);
