import * as Y from "yjs";
import * as monaco from "monaco-editor";
import * as error from "lib0/error.js";
import { createMutex } from "lib0/mutex.js";
import { Awareness } from "y-protocols/awareness.js"; // eslint-disable-line

class RelativeSelection {
  /** class that stores Y.RelationPosition
   * @param {Y.RelativePosition} start
   * @param {Y.RelativePosition} end
   * @param {monaco.SelectionDirection} direction
   */
  constructor(start, end, direction) {
    this.start = start;
    this.end = end;
    this.direction = direction;
  }
}

/** MonacoSelection => RelativeSelection (?)
 * @param {monaco.editor.IStandaloneCodeEditor} editor
 * @param {monaco.editor.ITextModel} monacoModel
 * @param {Y.Text} type
 */
const createRelativeSelection = (editor, monacoModel, type) => {
  const sel = editor.getSelection();
  if (sel !== null) {
    const startPos = sel.getStartPosition();
    const endPos = sel.getEndPosition();
    const start = Y.createRelativePositionFromTypeIndex(
      type,
      monacoModel.getOffsetAt(startPos)
    );
    const end = Y.createRelativePositionFromTypeIndex(
      type,
      monacoModel.getOffsetAt(endPos)
    );
    return new RelativeSelection(start, end, sel.getDirection());
  }
  return null;
};

/** RelativeSelection => MonacoSelection
 * @param {monaco.editor.IEditor} editor
 * @param {Y.Text} type
 * @param {RelativeSelection} relSel
 * @param {Y.Doc} doc
 * @return {null|monaco.Selection}
 */
const createMonacoSelectionFromRelativeSelection = (
  editor,
  type,
  relSel,
  doc
) => {
  const start = Y.createAbsolutePositionFromRelativePosition(relSel.start, doc);
  const end = Y.createAbsolutePositionFromRelativePosition(relSel.end, doc);
  if (
    start !== null &&
    end !== null &&
    start.type === type &&
    end.type === type
  ) {
    const model = /** @type {monaco.editor.ITextModel} */ (editor.getModel());
    const startPos = model.getPositionAt(start.index);
    const endPos = model.getPositionAt(end.index);
    return monaco.Selection.createWithDirection(
      startPos.lineNumber,
      startPos.column,
      endPos.lineNumber,
      endPos.column,
      relSel.direction
    );
  }
  return null;
};

// ------------------ START ------------------ //

export class MonacoBinding {
  /**
   * @param {Y.Text} ytext
   * @param {monaco.editor.ITextModel} monacoModel
   * @param {Set<monaco.editor.IStandaloneCodeEditor>} [editors] // why there is a set of editors
   * @param {Awareness?} [awareness]
   */
  constructor(ytext, monacoModel, editors = new Set(), awareness = null) {
    // what is the difference between Y.Doc and Y.Text?
    this.doc = /** @type {Y.Doc} */ (ytext.doc);
    this.ytext = ytext;

    // what is the difference between TextModel and Editor
    this.monacoModel = monacoModel;
    this.editors = editors;
    this.mux = createMutex();
    /**
     * @type {Map<monaco.editor.IStandaloneCodeEditor, RelativeSelection>}
     */
    this._savedSelections = new Map();

    // Event & Event handler: before all transaction
    this._beforeTransaction = () => {
      this.mux(() => {
        this._savedSelections = new Map();
        editors.forEach((editor) => {
          if (editor.getModel() === monacoModel) {
            const rsel = createRelativeSelection(editor, monacoModel, ytext);
            if (rsel !== null) {
              this._savedSelections.set(editor, rsel);
            }
          }
        });
      });
    };
    // Y.Doc transaction?
    this.doc.on("beforeAllTransactions", this._beforeTransaction);

    // what is decoration

    /**
     * @type {Map<monaco.editor.IStandaloneCodeEditor, string[]>}
     */
    this._decorations = new Map();
    // render decoration of editor?
    this._rerenderDecorations = () => {
      editors.forEach((editor) => {
        if (awareness && editor.getModel() === monacoModel) {
          // render decorations
          const currentDecorations = this._decorations.get(editor) || [];

          /**
           * @type {monaco.editor.IModelDeltaDecoration[]}
           */
          const newDecorations = [];
          awareness.getStates().forEach((state, clientID) => {
            // state contained info: selection(start, end)
            // client ID is yjs ID

            // if clientID is not mine, and selection from this client is not empty
            if (
              clientID !== this.doc.clientID &&
              state.selection != null &&
              state.selection.anchor != null &&
              state.selection.head != null
            ) {
              const anchorAbs = Y.createAbsolutePositionFromRelativePosition(
                state.selection.anchor,
                this.doc
              );
              const headAbs = Y.createAbsolutePositionFromRelativePosition(
                state.selection.head,
                this.doc
              );
              if (
                anchorAbs !== null &&
                headAbs !== null &&
                anchorAbs.type === ytext &&
                headAbs.type === ytext
              ) {
                let start, end, afterContentClassName, beforeContentClassName;

                // check if LTR or RTL
                if (anchorAbs.index < headAbs.index) {
                  start = monacoModel.getPositionAt(anchorAbs.index);
                  end = monacoModel.getPositionAt(headAbs.index);
                  afterContentClassName =
                    "yRemoteSelectionHead yRemoteSelectionHead-" + clientID;
                  beforeContentClassName = null;
                } else {
                  start = monacoModel.getPositionAt(headAbs.index);
                  end = monacoModel.getPositionAt(anchorAbs.index);
                  afterContentClassName = null;
                  beforeContentClassName =
                    "yRemoteSelectionHead yRemoteSelectionHead-" + clientID;
                }

                newDecorations.push({
                  range: new monaco.Range(
                    start.lineNumber,
                    start.column,
                    end.lineNumber,
                    end.column
                  ),
                  options: {
                    className: "yRemoteSelection yRemoteSelection-" + clientID,
                    afterContentClassName,
                    beforeContentClassName,
                  },
                });
              }
            }
          });
          // console.log("current", currentDecorations);
          // console.log("new", newDecorations);
          this._decorations.set(
            editor,
            // render decorations
            // All decorations added through this call will get the ownerId of this editor.
            editor.deltaDecorations(currentDecorations, newDecorations)
          );
        } else {
          // ignore decorations
          this._decorations.delete(editor);
        }
      });
    };

    // y.text observer. When y.text creates any event
    /**
     * @type {function(Y.YTextEvent, Y.Transaction):void}
     */
    this._ytextObserver = (event) => {
      this.mux(() => {
        let index = 0;
        // TODO what is delta
        event.delta.forEach((op) => {
          if (op.retain !== undefined) {
            index += op.retain;
          } else if (op.insert !== undefined) {
            const pos = monacoModel.getPositionAt(index);
            const range = new monaco.Selection(
              pos.lineNumber,
              pos.column,
              pos.lineNumber,
              pos.column
            );
            monacoModel.applyEdits([{ range, text: op.insert }]);
            index += op.insert.length;
          } else if (op.delete !== undefined) {
            const pos = monacoModel.getPositionAt(index);
            const endPos = monacoModel.getPositionAt(index + op.delete);
            const range = new monaco.Selection(
              pos.lineNumber,
              pos.column,
              endPos.lineNumber,
              endPos.column
            );
            monacoModel.applyEdits([{ range, text: "" }]);
          } else {
            throw error.unexpectedCase();
          }
        });

        // restore self-saved selections
        this._savedSelections.forEach((rsel, editor) => {
          const sel = createMonacoSelectionFromRelativeSelection(
            editor,
            ytext,
            rsel,
            this.doc
          );
          if (sel !== null) {
            console.log("Restore self-saved selections");
            console.log(sel);
            // if not restore, the selection will be enlarged by the insertion of text
            editor.setSelection(sel);
          }
        });
      });
      this._rerenderDecorations();
    };
    ytext.observe(this._ytextObserver);

    // why there creates a block-level scope?
    {
      // set value of monaco model to value of ytext
      const ytextValue = ytext.toString();
      if (monacoModel.getValue() !== ytextValue) {
        monacoModel.setValue(ytextValue);
      }
    }

    // this is a disposable handler
    // anyway, what is disposable?

    // apply change from model to y.text
    // This handler will fire a y.text event so that yTextObserver will be invoked

    /**
     * @type {monaco.IDisposable}
     */
    this._monacoChangeHandler = monacoModel.onDidChangeContent((event) => {
      // apply changes from right to left
      this.mux(() => {
        this.doc.transact(() => {
          event.changes
            .sort(
              (change1, change2) => change2.rangeOffset - change1.rangeOffset
            )
            .forEach((change) => {
              // it will trigger y.text event
              ytext.delete(change.rangeOffset, change.rangeLength);
              ytext.insert(change.rangeOffset, change.text);
            });
        }, this);
      });
    });

    // onWillDispose lifecycle method?
    monacoModel.onWillDispose(() => {
      this.destroy();
    });

    // register awareness
    if (awareness) {
      editors.forEach((editor) => {
        // when the cursor selection has changed, update selection(start, end) to awareness
        editor.onDidChangeCursorSelection(() => {
          if (editor.getModel() === monacoModel) {
            const sel = editor.getSelection();
            if (sel === null) {
              return;
            }
            let anchor = monacoModel.getOffsetAt(sel.getStartPosition());
            let head = monacoModel.getOffsetAt(sel.getEndPosition());
            if (sel.getDirection() === monaco.SelectionDirection.RTL) {
              const tmp = anchor;
              anchor = head;
              head = tmp;
            }
            awareness.setLocalStateField("selection", {
              anchor: Y.createRelativePositionFromTypeIndex(ytext, anchor),
              head: Y.createRelativePositionFromTypeIndex(ytext, head),
            });
          }
        });
        // when awareness changed, render decorations again
        awareness.on("change", this._rerenderDecorations);
      });
      this.awareness = awareness;
    }
  }

  // clean up when monacoModel.onWillDispose (this method is invoked here)
  destroy() {
    this._monacoChangeHandler.dispose();
    this.ytext.unobserve(this._ytextObserver);
    this.doc.off("beforeAllTransactions", this._beforeTransaction);
    if (this.awareness) {
      this.awareness.off("change", this._rerenderDecorations);
    }
  }
}
