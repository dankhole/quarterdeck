/**
 * Copyright (c) 2019 The xterm.js authors. All rights reserved.
 * @license MIT
 *
 * Repo-owned string serializer fork of @xterm/addon-serialize 0.14.0,
 * src/SerializeAddon.ts, upstream commit f447274f430fd22513f6adbf9862d19524471c04.
 * https://github.com/xtermjs/xterm.js/tree/f447274f430fd22513f6adbf9862d19524471c04/addons/addon-serialize
 *
 * HTML serialization is omitted. Traversal, wrap repair, SGR diffing, cursor
 * restoration and buffer/mode composition remain upstream. Quarterdeck adds
 * OSC 8 runs and restores the active hyperlink for subsequent live output.
 * The checked private boundary below is specific to pinned xterm 6.0.0.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */

/** biome-ignore-all lint/style/noNonNullAssertion lint/correctness/noUnusedFunctionParameters: Preserve upstream traversal invariants and hook signatures for source parity. */

import type { ISerializeOptions, ISerializeRange } from "@xterm/addon-serialize";
import type { IBuffer, IBufferCell, IBufferRange, ITerminalAddon, Terminal } from "@xterm/headless";

type IAttributeData = Omit<IBufferCell, "getChars" | "getWidth" | "getCode">;

interface Hyperlink {
	id?: string;
	uri: string;
}

const CLOSE_HYPERLINK = "\u001b]8;;\u001b\\";
// biome-ignore lint/suspicious/noControlCharactersInRegex: OSC payloads must not introduce terminal controls.
const UNSAFE_OSC_PAYLOAD = /[\u0000-\u001f\u007f-\u009f]/u;

function record(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null) throw new Error("Unsupported xterm 6 serialization internals");
	return value as Record<string, unknown>;
}

/** The only private xterm boundary. Fail explicitly on incompatible shapes. */
function getSerializationInternals(terminal: Terminal): {
	attributes: IAttributeData;
	hyperlink: (cell: unknown) => Hyperlink | undefined;
	style: (attributes: IAttributeData, target?: "cell" | "cursor") => IAttributeData;
} {
	const core = record(record(terminal)._core);
	const attributes = record(record(core._inputHandler)._curAttrData);
	const reference = terminal.buffer.active.getNullCell();
	const methods = [
		"getFgColorMode",
		"getBgColorMode",
		"getFgColor",
		"getBgColor",
		"isAttributeDefault",
		"isFgRGB",
		"isBgRGB",
		"isFgPalette",
		"isBgPalette",
		"isFgDefault",
		"isBgDefault",
		"isInverse",
		"isBold",
		"isUnderline",
		"isOverline",
		"isBlink",
		"isInvisible",
		"isItalic",
		"isDim",
		"isStrikethrough",
	] as const satisfies readonly (keyof IAttributeData)[];
	for (const method of methods) {
		if (typeof attributes[method] !== "function" || typeof reference[method] !== "function") {
			throw new Error("Unsupported xterm 6 cursor attributes");
		}
	}
	const links = record(core._oscLinkService);
	const lookup = links.getLinkData;
	if (typeof lookup !== "function") throw new Error("Unsupported xterm 6 OSC link service");
	return {
		attributes: attributes as unknown as IAttributeData,
		style(value, target = "cell") {
			const source = record(value);
			const hasExtendedAttrs = source.hasExtendedAttrs;
			if (typeof hasExtendedAttrs !== "function") throw new Error("Unsupported xterm 6 extended attributes");
			if (!Reflect.apply(hasExtendedAttrs, source, []) || record(source.extended).urlId === 0) return value;
			// A disposed link can still leave URL attributes on retained cells.
			// Without a resolvable OSC link, preserve a retained cell's visible
			// style through SGR. Current cursor attributes must instead retain
			// only explicit SGR, even for disposed links: a later OSC close must
			// not leave their synthetic underline on newly printed characters.
			if (target === "cell" && Reflect.apply(lookup, links, [record(source.extended).urlId]) === undefined) {
				return value;
			}
			// isUnderline() includes a synthetic dashed underline for OSC links.
			// SGR must reflect only the underlying explicit style, or closing OSC 8
			// would leave that synthetic underline behind on the live suffix.
			const clone = source.clone;
			if (typeof clone !== "function") throw new Error("Unsupported xterm 6 attribute clone");
			const plain = record(Reflect.apply(clone, source, []));
			const updateExtended = plain.updateExtended;
			if (typeof updateExtended !== "function") throw new Error("Unsupported xterm 6 attribute update");
			record(plain.extended).urlId = 0;
			Reflect.apply(updateExtended, plain, []);
			return plain as unknown as IAttributeData;
		},
		hyperlink(cell) {
			const source = record(cell);
			const hasExtendedAttrs = source.hasExtendedAttrs;
			if (typeof hasExtendedAttrs !== "function") throw new Error("Unsupported xterm 6 extended attributes");
			// BufferLine.loadCell intentionally leaves extended stale when reusing
			// a cell without HAS_EXTENDED. Never interpret that old URL as current.
			if (!Reflect.apply(hasExtendedAttrs, source, [])) return undefined;
			const urlId = record(source.extended).urlId;
			if (typeof urlId !== "number" || !Number.isSafeInteger(urlId) || urlId < 0) {
				throw new Error("Unsupported xterm 6 hyperlink attributes");
			}
			if (urlId === 0) return undefined;
			const resolved = Reflect.apply(lookup, links, [urlId]);
			// Clearing an alternate screen or trimming the last marked row can
			// dispose the entry while cells/current attributes retain its urlId.
			if (resolved === undefined) return undefined;
			const data = record(resolved);
			if (typeof data.uri !== "string" || (data.id !== undefined && typeof data.id !== "string")) {
				throw new Error("Unsupported xterm 6 hyperlink data");
			}
			// Never turn private link data into executable terminal control bytes.
			if (
				UNSAFE_OSC_PAYLOAD.test(data.uri) ||
				(typeof data.id === "string" && (UNSAFE_OSC_PAYLOAD.test(data.id) || /[:;]/u.test(data.id)))
			) {
				throw new Error("Unsafe xterm hyperlink data");
			}
			return { uri: data.uri, ...(typeof data.id === "string" ? { id: data.id } : {}) };
		},
	};
}

function openHyperlink(link: Hyperlink): string {
	return `\u001b]8;${link.id === undefined ? "" : `id=${link.id}`};${link.uri}\u001b\\`;
}

function constrain(value: number, low: number, high: number): number {
	return Math.max(low, Math.min(value, high));
}

// TODO: Refine this template class later
abstract class BaseSerializeHandler {
	constructor(protected readonly _buffer: IBuffer) {}

	public serialize(range: IBufferRange, excludeFinalCursorPosition?: boolean): string {
		// we need two of them to flip between old and new cell
		const cell1 = this._buffer.getNullCell();
		const cell2 = this._buffer.getNullCell();
		let oldCell = cell1;

		const startRow = range.start.y;
		const endRow = range.end.y;
		const startColumn = range.start.x;
		const endColumn = range.end.x;

		this._beforeSerialize(endRow - startRow, startRow, endRow);

		for (let row = startRow; row <= endRow; row++) {
			const line = this._buffer.getLine(row);
			if (line) {
				const startLineColumn = row === range.start.y ? startColumn : 0;
				const endLineColumn = row === range.end.y ? endColumn : line.length;
				for (let col = startLineColumn; col < endLineColumn; col++) {
					const c = line.getCell(col, oldCell === cell1 ? cell2 : cell1);
					if (!c) {
						console.warn(`Can't get cell at row=${row}, col=${col}`);
						continue;
					}
					this._nextCell(c, oldCell, row, col);
					oldCell = c;
				}
			}
			this._rowEnd(row, row === endRow);
		}

		this._afterSerialize();

		return this._serializeString(excludeFinalCursorPosition);
	}

	protected _nextCell(cell: IBufferCell, oldCell: IBufferCell, row: number, col: number): void {}
	protected _rowEnd(row: number, isLastRow: boolean): void {}
	protected _beforeSerialize(rows: number, startRow: number, endRow: number): void {}
	protected _afterSerialize(): void {}
	protected _serializeString(excludeFinalCursorPosition?: boolean): string {
		return "";
	}
}

function equalFg(cell1: IBufferCell | IAttributeData, cell2: IAttributeData): boolean {
	return cell1.getFgColorMode() === cell2.getFgColorMode() && cell1.getFgColor() === cell2.getFgColor();
}

function equalBg(cell1: IBufferCell | IAttributeData, cell2: IAttributeData): boolean {
	return cell1.getBgColorMode() === cell2.getBgColorMode() && cell1.getBgColor() === cell2.getBgColor();
}

function equalFlags(cell1: IBufferCell | IAttributeData, cell2: IAttributeData): boolean {
	return (
		cell1.isInverse() === cell2.isInverse() &&
		cell1.isBold() === cell2.isBold() &&
		cell1.isUnderline() === cell2.isUnderline() &&
		cell1.isOverline() === cell2.isOverline() &&
		cell1.isBlink() === cell2.isBlink() &&
		cell1.isInvisible() === cell2.isInvisible() &&
		cell1.isItalic() === cell2.isItalic() &&
		cell1.isDim() === cell2.isDim() &&
		cell1.isStrikethrough() === cell2.isStrikethrough()
	);
}

class StringSerializeHandler extends BaseSerializeHandler {
	private _rowIndex: number = 0;
	private _allRows: string[] = [] as string[];
	private _allRowSeparators: string[] = [] as string[];
	private _currentRow: string = "";
	private _nullCellCount: number = 0;
	private _activeHyperlink: Hyperlink | undefined;
	private readonly _internals: ReturnType<typeof getSerializationInternals>;

	private _setHyperlink(link: Hyperlink | undefined): void {
		if (this._activeHyperlink?.uri === link?.uri && this._activeHyperlink?.id === link?.id) return;
		this._currentRow += link ? openHyperlink(link) : CLOSE_HYPERLINK;
		this._activeHyperlink = link;
	}

	// we can see a full colored cell and a null cell that only have background the same style
	// but the information isn't preserved by null cell itself
	// so wee need to record it when required.
	private _cursorStyle: IBufferCell = this._buffer.getNullCell();

	// where exact the cursor styles comes from
	// because we can't copy the cell directly
	// so we remember where the content comes from instead
	private _cursorStyleRow: number = 0;
	private _cursorStyleCol: number = 0;

	// this is a null cell for reference for checking whether background is empty or not
	private _backgroundCell: IBufferCell = this._buffer.getNullCell();

	private _firstRow: number = 0;
	private _lastCursorRow: number = 0;
	private _lastCursorCol: number = 0;
	private _lastContentCursorRow: number = 0;
	private _lastContentCursorCol: number = 0;

	constructor(
		buffer: IBuffer,
		private readonly _terminal: Terminal,
	) {
		super(buffer);
		this._internals = getSerializationInternals(_terminal);
	}

	protected _beforeSerialize(rows: number, start: number, end: number): void {
		this._allRows = new Array<string>(rows);
		this._lastContentCursorRow = start;
		this._lastCursorRow = start;
		this._firstRow = start;
	}

	private _thisRowLastChar: IBufferCell = this._buffer.getNullCell();
	private _thisRowLastSecondChar: IBufferCell = this._buffer.getNullCell();
	private _nextRowFirstChar: IBufferCell = this._buffer.getNullCell();
	protected _rowEnd(row: number, isLastRow: boolean): void {
		// if there is colorful empty cell at line end, whe must pad it back, or the the color block
		// will missing
		if (this._nullCellCount > 0 && !equalBg(this._cursorStyle, this._backgroundCell)) {
			// use clear right to set background.
			this._currentRow += `\u001b[${this._nullCellCount}X`;
		}

		let rowSeparator = "";

		// handle row separator
		if (!isLastRow) {
			// Enable BCE
			if (row - this._firstRow >= this._terminal.rows) {
				this._buffer.getLine(this._cursorStyleRow)?.getCell(this._cursorStyleCol, this._backgroundCell);
			}

			// Fetch current line
			const currentLine = this._buffer.getLine(row)!;
			// Fetch next line
			const nextLine = this._buffer.getLine(row + 1)!;

			if (!nextLine.isWrapped) {
				// just insert the line break
				rowSeparator = "\r\n";
				// we sended the enter
				this._lastCursorRow = row + 1;
				this._lastCursorCol = 0;
			} else {
				rowSeparator = "";
				const thisRowLastChar = currentLine.getCell(currentLine.length - 1, this._thisRowLastChar)!;
				const thisRowLastSecondChar = currentLine.getCell(currentLine.length - 2, this._thisRowLastSecondChar)!;
				const nextRowFirstChar = nextLine.getCell(0, this._nextRowFirstChar)!;
				const isNextRowFirstCharDoubleWidth = nextRowFirstChar.getWidth() > 1;

				// validate whether this line wrap is ever possible
				// which mean whether cursor can placed at a overflow position (x === row) naturally
				let isValid = false;

				if (
					// you must output character to cause overflow, control sequence can't do this
					nextRowFirstChar.getChars() && isNextRowFirstCharDoubleWidth
						? this._nullCellCount <= 1
						: this._nullCellCount <= 0
				) {
					if (
						// the last character can't be null,
						// you can't use control sequence to move cursor to (x === row)
						(thisRowLastChar.getChars() || thisRowLastChar.getWidth() === 0) &&
						// change background of the first wrapped cell also affects BCE
						// so we mark it as invalid to simply the process to determine line separator
						equalBg(thisRowLastChar, nextRowFirstChar)
					) {
						isValid = true;
					}

					if (
						// the second to last character can't be null if the next line starts with CJK,
						// you can't use control sequence to move cursor to (x === row)
						isNextRowFirstCharDoubleWidth &&
						(thisRowLastSecondChar.getChars() || thisRowLastSecondChar.getWidth() === 0) &&
						// change background of the first wrapped cell also affects BCE
						// so we mark it as invalid to simply the process to determine line separator
						equalBg(thisRowLastChar, nextRowFirstChar) &&
						equalBg(thisRowLastSecondChar, nextRowFirstChar)
					) {
						isValid = true;
					}
				}

				if (!isValid) {
					// These synthetic printed characters must not inherit the last
					// content link. Ordinary CRLF/padding below prints no characters
					// and can safely keep a run open without repeating a large URI.
					this._setHyperlink(undefined);
					// force the wrap with magic
					// insert enough character to force the wrap
					rowSeparator = "-".repeat(this._nullCellCount + 1);
					// move back and erase next line head
					rowSeparator += "\u001b[1D\u001b[1X";

					if (this._nullCellCount > 0) {
						// do these because we filled the last several null slot, which we shouldn't
						rowSeparator += "\u001b[A";
						rowSeparator += `\u001b[${currentLine.length - this._nullCellCount}C`;
						rowSeparator += `\u001b[${this._nullCellCount}X`;
						rowSeparator += `\u001b[${currentLine.length - this._nullCellCount}D`;
						rowSeparator += "\u001b[B";
					}

					// This is content and need the be serialized even it is invisible.
					// without this, wrap will be missing from outputs.
					this._lastContentCursorRow = row + 1;
					this._lastContentCursorCol = 0;

					// force commit the cursor position
					this._lastCursorRow = row + 1;
					this._lastCursorCol = 0;
				}
			}
		}

		this._allRows[this._rowIndex] = this._currentRow;
		this._allRowSeparators[this._rowIndex++] = rowSeparator;
		this._currentRow = "";
		this._nullCellCount = 0;
	}

	private _diffStyle(cell: IBufferCell | IAttributeData, oldCell: IAttributeData): number[] {
		cell = this._internals.style(cell);
		oldCell = this._internals.style(oldCell);
		const sgrSeq: number[] = [];
		const fgChanged = !equalFg(cell, oldCell);
		const bgChanged = !equalBg(cell, oldCell);
		const flagsChanged = !equalFlags(cell, oldCell);

		if (fgChanged || bgChanged || flagsChanged) {
			if (cell.isAttributeDefault()) {
				if (!oldCell.isAttributeDefault()) {
					sgrSeq.push(0);
				}
			} else {
				if (fgChanged) {
					const color = cell.getFgColor();
					if (cell.isFgRGB()) {
						sgrSeq.push(38, 2, (color >>> 16) & 0xff, (color >>> 8) & 0xff, color & 0xff);
					} else if (cell.isFgPalette()) {
						if (color >= 16) {
							sgrSeq.push(38, 5, color);
						} else {
							sgrSeq.push(color & 8 ? 90 + (color & 7) : 30 + (color & 7));
						}
					} else {
						sgrSeq.push(39);
					}
				}
				if (bgChanged) {
					const color = cell.getBgColor();
					if (cell.isBgRGB()) {
						sgrSeq.push(48, 2, (color >>> 16) & 0xff, (color >>> 8) & 0xff, color & 0xff);
					} else if (cell.isBgPalette()) {
						if (color >= 16) {
							sgrSeq.push(48, 5, color);
						} else {
							sgrSeq.push(color & 8 ? 100 + (color & 7) : 40 + (color & 7));
						}
					} else {
						sgrSeq.push(49);
					}
				}
				if (flagsChanged) {
					if (cell.isInverse() !== oldCell.isInverse()) {
						sgrSeq.push(cell.isInverse() ? 7 : 27);
					}
					if (cell.isBold() !== oldCell.isBold()) {
						sgrSeq.push(cell.isBold() ? 1 : 22);
					}
					if (cell.isUnderline() !== oldCell.isUnderline()) {
						sgrSeq.push(cell.isUnderline() ? 4 : 24);
					}
					if (cell.isOverline() !== oldCell.isOverline()) {
						sgrSeq.push(cell.isOverline() ? 53 : 55);
					}
					if (cell.isBlink() !== oldCell.isBlink()) {
						sgrSeq.push(cell.isBlink() ? 5 : 25);
					}
					if (cell.isInvisible() !== oldCell.isInvisible()) {
						sgrSeq.push(cell.isInvisible() ? 8 : 28);
					}
					if (cell.isItalic() !== oldCell.isItalic()) {
						sgrSeq.push(cell.isItalic() ? 3 : 23);
					}
					if (cell.isDim() !== oldCell.isDim()) {
						sgrSeq.push(cell.isDim() ? 2 : 22);
					}
					if (cell.isStrikethrough() !== oldCell.isStrikethrough()) {
						sgrSeq.push(cell.isStrikethrough() ? 9 : 29);
					}
				}
			}
		}

		return sgrSeq;
	}

	protected _nextCell(cell: IBufferCell, oldCell: IBufferCell, row: number, col: number): void {
		// a width 0 cell don't need to be count because it is just a placeholder after a CJK character;
		const isPlaceHolderCell = cell.getWidth() === 0;

		if (isPlaceHolderCell) {
			return;
		}

		// this cell don't have content
		const isEmptyCell = cell.getChars() === "";

		const sgrSeq = this._diffStyle(cell, this._cursorStyle);

		// the empty cell style is only assumed to be changed when background changed, because
		// foreground is always 0.
		const styleChanged = isEmptyCell ? !equalBg(this._cursorStyle, cell) : sgrSeq.length > 0;

		/**
		 *  handles style change
		 */
		if (styleChanged) {
			// before update the style, we need to fill empty cell back
			if (this._nullCellCount > 0) {
				// use clear right to set background.
				if (!equalBg(this._cursorStyle, this._backgroundCell)) {
					this._currentRow += `\u001b[${this._nullCellCount}X`;
				}
				// use move right to move cursor.
				this._currentRow += `\u001b[${this._nullCellCount}C`;
				this._nullCellCount = 0;
			}

			this._lastContentCursorRow = this._lastCursorRow = row;
			this._lastContentCursorCol = this._lastCursorCol = col;

			this._currentRow += `\u001b[${sgrSeq.join(";")}m`;

			// update the last cursor style
			const line = this._buffer.getLine(row);
			if (line !== undefined) {
				line.getCell(col, this._cursorStyle);
				this._cursorStyleRow = row;
				this._cursorStyleCol = col;
			}
		}

		/**
		 *  handles actual content
		 */
		if (isEmptyCell) {
			this._nullCellCount += cell.getWidth();
		} else {
			if (this._nullCellCount > 0) {
				// we can just assume we have same style with previous one here
				// because style change is handled by previous stage
				// use move right when background is empty, use clear right when there is background.
				if (equalBg(this._cursorStyle, this._backgroundCell)) {
					this._currentRow += `\u001b[${this._nullCellCount}C`;
				} else {
					this._currentRow += `\u001b[${this._nullCellCount}X`;
					this._currentRow += `\u001b[${this._nullCellCount}C`;
				}
				this._nullCellCount = 0;
			}

			this._setHyperlink(this._internals.hyperlink(cell));
			this._currentRow += cell.getChars();

			// update cursor
			this._lastContentCursorRow = this._lastCursorRow = row;
			this._lastContentCursorCol = this._lastCursorCol = col + cell.getWidth();
		}
	}

	protected _serializeString(excludeFinalCursorPosition?: boolean): string {
		let rowEnd = this._allRows.length;

		// the fixup is only required for data without scrollback
		// because it will always be placed at last line otherwise
		if (this._buffer.length - this._firstRow <= this._terminal.rows) {
			rowEnd = this._lastContentCursorRow + 1 - this._firstRow;
			this._lastCursorCol = this._lastContentCursorCol;
			this._lastCursorRow = this._lastContentCursorRow;
		}

		let content = "";

		for (let i = 0; i < rowEnd; i++) {
			content += this._allRows[i];
			if (i + 1 < rowEnd) {
				content += this._allRowSeparators[i];
			}
		}

		// Keep runs open across nonprinting padding and CRLF, but end emitted
		// runs before buffer composition and restoring the provider's live state.
		// An untouched buffer must remain exactly empty for the browser's stale
		// empty-restore guard; do not add protocol bytes without an emitted link.
		if (this._activeHyperlink) content += CLOSE_HYPERLINK;

		// restore the cursor
		if (!excludeFinalCursorPosition) {
			const realCursorRow = this._buffer.baseY + this._buffer.cursorY;
			const realCursorCol = this._buffer.cursorX;

			const cursorMoved = realCursorRow !== this._lastCursorRow || realCursorCol !== this._lastCursorCol;

			const moveRight = (offset: number): void => {
				if (offset > 0) {
					content += `\u001b[${offset}C`;
				} else if (offset < 0) {
					content += `\u001b[${-offset}D`;
				}
			};
			const moveDown = (offset: number): void => {
				if (offset > 0) {
					content += `\u001b[${offset}B`;
				} else if (offset < 0) {
					content += `\u001b[${-offset}A`;
				}
			};

			if (cursorMoved) {
				moveDown(realCursorRow - this._lastCursorRow);
				moveRight(realCursorCol - this._lastCursorCol);
			}
		}

		// Restore the cursor's current style, see https://github.com/xtermjs/xterm.js/issues/3677
		// HACK: Internal API access since it's awkward to expose this in the API and serialize will
		// likely be the only consumer
		const curAttrData = this._internals.style(this._internals.attributes, "cursor");
		const sgrSeq = this._diffStyle(curAttrData, this._cursorStyle);
		if (sgrSeq.length > 0) {
			content += `\u001b[${sgrSeq.join(";")}m`;
		}

		return content;
	}
}

export class SerializeAddon implements ITerminalAddon {
	private _terminal: Terminal | undefined;

	public activate(terminal: Terminal): void {
		this._terminal = terminal;
	}

	private _serializeBufferByScrollback(terminal: Terminal, buffer: IBuffer, scrollback?: number): string {
		const maxRows = buffer.length;
		const correctRows = scrollback === undefined ? maxRows : constrain(scrollback + terminal.rows, 0, maxRows);
		return this._serializeBufferByRange(
			terminal,
			buffer,
			{
				start: maxRows - correctRows,
				end: maxRows - 1,
			},
			false,
		);
	}

	private _serializeBufferByRange(
		terminal: Terminal,
		buffer: IBuffer,
		range: ISerializeRange,
		excludeFinalCursorPosition: boolean,
	): string {
		const handler = new StringSerializeHandler(buffer, terminal);
		return handler.serialize(
			{
				start: { x: 0, y: typeof range.start === "number" ? range.start : range.start.line },
				end: { x: terminal.cols, y: typeof range.end === "number" ? range.end : range.end.line },
			},
			excludeFinalCursorPosition,
		);
	}

	private _serializeModes(terminal: Terminal): string {
		let content = "";
		const modes = terminal.modes;

		// Default: false
		if (modes.applicationCursorKeysMode) content += "\x1b[?1h";
		if (modes.applicationKeypadMode) content += "\x1b[?66h";
		if (modes.bracketedPasteMode) content += "\x1b[?2004h";
		if (modes.insertMode) content += "\x1b[4h";
		if (modes.originMode) content += "\x1b[?6h";
		if (modes.reverseWraparoundMode) content += "\x1b[?45h";
		if (modes.sendFocusMode) content += "\x1b[?1004h";
		// synchronizedOutputMode doesn't need to be serialized as it's a temporary mode

		// Default: true
		if (modes.wraparoundMode === false) content += "\x1b[?7l";

		// Default: 'none'
		if (modes.mouseTrackingMode !== "none") {
			switch (modes.mouseTrackingMode) {
				case "x10":
					content += "\x1b[?9h";
					break;
				case "vt200":
					content += "\x1b[?1000h";
					break;
				case "drag":
					content += "\x1b[?1002h";
					break;
				case "any":
					content += "\x1b[?1003h";
					break;
			}
		}

		return content;
	}

	public serialize(options?: ISerializeOptions): string {
		// TODO: Add combinedData support
		if (!this._terminal) {
			throw new Error("Cannot use addon until it has been loaded");
		}

		// Normal buffer
		let content = options?.range
			? this._serializeBufferByRange(this._terminal, this._terminal.buffer.normal, options.range, true)
			: this._serializeBufferByScrollback(this._terminal, this._terminal.buffer.normal, options?.scrollback);

		// Alternate buffer
		if (!options?.excludeAltBuffer) {
			if (this._terminal.buffer.active.type === "alternate") {
				const alternativeScreenContent = this._serializeBufferByScrollback(
					this._terminal,
					this._terminal.buffer.alternate,
					undefined,
				);
				content += `\u001b[?1049h\u001b[H${alternativeScreenContent}`;
			}
		}

		// Modes
		if (!options?.excludeModes) {
			content += this._serializeModes(this._terminal);
		}

		// A snapshot may be followed by live bytes while the provider's OSC 8 run
		// remains open. Buffer serialization closes its own runs at buffer boundaries;
		// restore the provider's current link only after all buffers and modes.
		const internals = getSerializationInternals(this._terminal);
		const currentLink = internals.hyperlink(internals.attributes);
		if (!content && !currentLink) return "";
		return CLOSE_HYPERLINK + content + (currentLink ? openHyperlink(currentLink) : "");
	}

	public dispose(): void {}
}
