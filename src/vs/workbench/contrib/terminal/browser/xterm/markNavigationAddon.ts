/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { coalesce } from 'vs/base/common/arrays';
import { Disposable } from 'vs/base/common/lifecycle';
import { IMarkTracker } from 'vs/workbench/contrib/terminal/browser/terminal';
import { IBufferMarkDetectionCapability, ICommandDetectionCapability, IPartialCommandDetectionCapability, ITerminalCapabilityStore, TerminalCapability } from 'vs/platform/terminal/common/capabilities/capabilities';
import type { Terminal, IMarker, ITerminalAddon, IDecoration } from 'xterm';
import { timeout } from 'vs/base/common/async';
import { IColorTheme, ICssStyleCollector, IThemeService, registerThemingParticipant } from 'vs/platform/theme/common/themeService';
import { focusBorder } from 'vs/platform/theme/common/colorRegistry';
import { TERMINAL_OVERVIEW_RULER_CURSOR_FOREGROUND_COLOR } from 'vs/workbench/contrib/terminal/common/terminalColorRegistry';

export enum Boundary {
	Top,
	Bottom
}

export const enum ScrollPosition {
	Top,
	Middle
}

export class MarkNavigationAddon extends Disposable implements IMarkTracker, ITerminalAddon {
	private _currentMarker: IMarker | Boundary = Boundary.Bottom;
	private _selectionStart: IMarker | Boundary | null = null;
	private _isDisposable: boolean = false;
	protected _terminal: Terminal | undefined;
	private _navigationDecoration: IDecoration | undefined;

	private _detectionCapability?: ICommandDetectionCapability | IPartialCommandDetectionCapability | IBufferMarkDetectionCapability;

	activate(terminal: Terminal): void {
		this._terminal = terminal;
		this._register(this._terminal.onData(() => {
			this._currentMarker = Boundary.Bottom;
		}));
	}

	constructor(
		store: ITerminalCapabilityStore,
		@IThemeService private readonly _themeService: IThemeService
	) {
		super();
		this._refreshActiveCapability(store);
		this._register(store.onDidAddCapability(() => this._refreshActiveCapability(store)));
		this._register(store.onDidRemoveCapability(() => this._refreshActiveCapability(store)));
	}

	private _refreshActiveCapability(store: ITerminalCapabilityStore) {
		const activeDetection = store.get(TerminalCapability.BufferMarkDetection) || store.get(TerminalCapability.CommandDetection) || store.get(TerminalCapability.PartialCommandDetection);
		if (activeDetection !== this._detectionCapability) {
			this._detectionCapability = activeDetection;
		}
	}

	private _getMarkers(): readonly IMarker[] {
		if (!this._detectionCapability) {
			return [];
		}
		let markers: readonly IMarker[] = [];
		switch (this._detectionCapability.type) {
			case TerminalCapability.PartialCommandDetection:
				markers = this._detectionCapability.commands;
				break;
			case TerminalCapability.CommandDetection:
				markers = coalesce(this._detectionCapability.commands.map(e => e.marker));
				break;
			case TerminalCapability.BufferMarkDetection:
				markers = Array.from(this._detectionCapability.marks.values());
				break;
		}
		return markers;
	}

	clearMarker(): void {
		// Clear the current marker so successive focus/selection actions are performed from the
		// bottom of the buffer
		this._currentMarker = Boundary.Bottom;
		this._resetNavigationDecoration();
		this._selectionStart = null;
	}

	private _resetNavigationDecoration() {
		this._navigationDecoration?.dispose();
		this._navigationDecoration = undefined;
	}

	scrollToPreviousMark(scrollPosition: ScrollPosition = ScrollPosition.Middle, retainSelection: boolean = false): void {
		if (!this._terminal) {
			return;
		}
		if (!retainSelection) {
			this._selectionStart = null;
		}

		let markerIndex;
		const currentLineY = typeof this._currentMarker === 'object'
			? this._getTargetScrollLine(this._terminal, this._currentMarker, scrollPosition)
			: Math.min(getLine(this._terminal, this._currentMarker), this._terminal.buffer.active.baseY);
		const viewportY = this._terminal.buffer.active.viewportY;
		if (typeof this._currentMarker === 'object' ? !this._isMarkerInViewport(this._terminal, this._currentMarker) : currentLineY !== viewportY) {
			// The user has scrolled, find the line based on the current scroll position. This only
			// works when not retaining selection
			const markersBelowViewport = this._getMarkers().filter(e => e.line >= viewportY).length;
			// -1 will scroll to the top
			markerIndex = this._getMarkers().length - markersBelowViewport - 1;
		} else if (this._currentMarker === Boundary.Bottom) {
			markerIndex = this._getMarkers().length - 1;
		} else if (this._currentMarker === Boundary.Top) {
			markerIndex = -1;
		} else if (this._isDisposable) {
			markerIndex = this._findPreviousMark(this._terminal);
			this._currentMarker.dispose();
			this._isDisposable = false;
		} else {
			markerIndex = this._getMarkers().indexOf(this._currentMarker) - 1;
		}

		if (markerIndex < 0) {
			this._currentMarker = Boundary.Top;
			this._terminal.scrollToTop();
			this._resetNavigationDecoration();
			return;
		}

		this._currentMarker = this._getMarkers()[markerIndex];
		this._scrollToMarker(this._currentMarker, scrollPosition);
	}

	scrollToNextMark(scrollPosition: ScrollPosition = ScrollPosition.Middle, retainSelection: boolean = false): void {
		if (!this._terminal) {
			return;
		}
		if (!retainSelection) {
			this._selectionStart = null;
		}

		let markerIndex;
		const currentLineY = typeof this._currentMarker === 'object'
			? this._getTargetScrollLine(this._terminal, this._currentMarker, scrollPosition)
			: Math.min(getLine(this._terminal, this._currentMarker), this._terminal.buffer.active.baseY);
		const viewportY = this._terminal.buffer.active.viewportY;
		if (typeof this._currentMarker === 'object' ? !this._isMarkerInViewport(this._terminal, this._currentMarker) : currentLineY !== viewportY) {
			// The user has scrolled, find the line based on the current scroll position. This only
			// works when not retaining selection
			const markersAboveViewport = this._getMarkers().filter(e => e.line <= viewportY).length;
			// markers.length will scroll to the bottom
			markerIndex = markersAboveViewport;
		} else if (this._currentMarker === Boundary.Bottom) {
			markerIndex = this._getMarkers().length;
		} else if (this._currentMarker === Boundary.Top) {
			markerIndex = 0;
		} else if (this._isDisposable) {
			markerIndex = this._findNextMark(this._terminal);
			this._currentMarker.dispose();
			this._isDisposable = false;
		} else {
			markerIndex = this._getMarkers().indexOf(this._currentMarker) + 1;
		}

		if (markerIndex >= this._getMarkers().length) {
			this._currentMarker = Boundary.Bottom;
			this._terminal.scrollToBottom();
			this._resetNavigationDecoration();
			return;
		}

		this._currentMarker = this._getMarkers()[markerIndex];
		this._scrollToMarker(this._currentMarker, scrollPosition);
	}

	private _scrollToMarker(marker: IMarker, position: ScrollPosition): void {
		if (!this._terminal) {
			return;
		}
		if (!this._isMarkerInViewport(this._terminal, marker)) {
			const line = this._getTargetScrollLine(this._terminal, marker, position);
			this._terminal.scrollToLine(line);
		}
		this._navigationDecoration?.dispose();
		const color = this._themeService.getColorTheme().getColor(TERMINAL_OVERVIEW_RULER_CURSOR_FOREGROUND_COLOR);

		const decoration = this._terminal.registerDecoration({
			marker,
			width: this._terminal.cols,
			overviewRulerOptions: {
				color: color?.toString() || '#a0a0a0cc'
			}
		});
		this._navigationDecoration = decoration;
		if (decoration) {
			let renderedElement: HTMLElement | undefined;

			decoration.onRender(element => {
				if (!renderedElement) {
					renderedElement = element;
					element.classList.add('terminal-scroll-highlight', 'terminal-scroll-highlight-outline');
					if (this._terminal?.element) {
						element.style.marginLeft = `-${getComputedStyle(this._terminal.element).paddingLeft}`;
					}
				}
			});
			decoration.onDispose(() => {
				if (decoration === this._navigationDecoration) {
					this._navigationDecoration = undefined;
				}
			});
			// Number picked to align with symbol highlight in the editor
			timeout(350).then(() => {
				if (renderedElement) {
					renderedElement.classList.remove('terminal-scroll-highlight-outline');
				}
			});
		}
	}

	private _getTargetScrollLine(terminal: Terminal, marker: IMarker, position: ScrollPosition) {
		// Middle is treated at 1/4 of the viewport's size because context below is almost always
		// more important than context above in the terminal.
		if (position === ScrollPosition.Middle) {
			return Math.max(marker.line - Math.floor(terminal.rows / 4), 0);
		}
		return marker.line;
	}

	private _isMarkerInViewport(terminal: Terminal, marker: IMarker) {
		const viewportY = terminal.buffer.active.viewportY;
		return marker.line >= viewportY && marker.line < viewportY + terminal.rows;
	}

	selectToPreviousMark(): void {
		if (!this._terminal) {
			return;
		}
		if (this._selectionStart === null) {
			this._selectionStart = this._currentMarker;
		}
		this.scrollToPreviousMark(ScrollPosition.Middle, true);
		selectLines(this._terminal, this._currentMarker, this._selectionStart);
	}

	selectToNextMark(): void {
		if (!this._terminal) {
			return;
		}
		if (this._selectionStart === null) {
			this._selectionStart = this._currentMarker;
		}
		this.scrollToNextMark(ScrollPosition.Middle, true);
		selectLines(this._terminal, this._currentMarker, this._selectionStart);
	}

	selectToPreviousLine(): void {
		if (!this._terminal) {
			return;
		}
		if (this._selectionStart === null) {
			this._selectionStart = this._currentMarker;
		}
		this.scrollToPreviousLine(this._terminal, ScrollPosition.Middle, true);
		selectLines(this._terminal, this._currentMarker, this._selectionStart);
	}

	selectToNextLine(): void {
		if (!this._terminal) {
			return;
		}
		if (this._selectionStart === null) {
			this._selectionStart = this._currentMarker;
		}
		this.scrollToNextLine(this._terminal, ScrollPosition.Middle, true);
		selectLines(this._terminal, this._currentMarker, this._selectionStart);
	}

	scrollToPreviousLine(xterm: Terminal, scrollPosition: ScrollPosition = ScrollPosition.Middle, retainSelection: boolean = false): void {
		if (!retainSelection) {
			this._selectionStart = null;
		}

		if (this._currentMarker === Boundary.Top) {
			xterm.scrollToTop();
			return;
		}

		if (this._currentMarker === Boundary.Bottom) {
			this._currentMarker = this._registerMarkerOrThrow(xterm, this._getOffset(xterm) - 1);
		} else {
			const offset = this._getOffset(xterm);
			if (this._isDisposable) {
				this._currentMarker.dispose();
			}
			this._currentMarker = this._registerMarkerOrThrow(xterm, offset - 1);
		}
		this._isDisposable = true;
		this._scrollToMarker(this._currentMarker, scrollPosition);
	}

	scrollToNextLine(xterm: Terminal, scrollPosition: ScrollPosition = ScrollPosition.Middle, retainSelection: boolean = false): void {
		if (!retainSelection) {
			this._selectionStart = null;
		}

		if (this._currentMarker === Boundary.Bottom) {
			xterm.scrollToBottom();
			return;
		}

		if (this._currentMarker === Boundary.Top) {
			this._currentMarker = this._registerMarkerOrThrow(xterm, this._getOffset(xterm) + 1);
		} else {
			const offset = this._getOffset(xterm);
			if (this._isDisposable) {
				this._currentMarker.dispose();
			}
			this._currentMarker = this._registerMarkerOrThrow(xterm, offset + 1);
		}
		this._isDisposable = true;
		this._scrollToMarker(this._currentMarker, scrollPosition);
	}

	scrollToClosestMark(startMarker: IMarker, endMarker?: IMarker | undefined, highlight?: boolean | undefined): void {
		this._scrollToMarker(startMarker, ScrollPosition.Top);
		if (highlight && endMarker) {
			this._terminal?.selectLines(startMarker.line, endMarker.line);
		}
	}

	private _registerMarkerOrThrow(xterm: Terminal, cursorYOffset: number): IMarker {
		const marker = xterm.registerMarker(cursorYOffset);
		if (!marker) {
			throw new Error(`Could not create marker for ${cursorYOffset}`);
		}
		return marker;
	}

	private _getOffset(xterm: Terminal): number {
		if (this._currentMarker === Boundary.Bottom) {
			return 0;
		} else if (this._currentMarker === Boundary.Top) {
			return 0 - (xterm.buffer.active.baseY + xterm.buffer.active.cursorY);
		} else {
			let offset = getLine(xterm, this._currentMarker);
			offset -= xterm.buffer.active.baseY + xterm.buffer.active.cursorY;
			return offset;
		}
	}

	private _findPreviousMark(xterm: Terminal): number {
		if (this._currentMarker === Boundary.Top) {
			return 0;
		} else if (this._currentMarker === Boundary.Bottom) {
			return this._getMarkers().length - 1;
		}

		let i;
		for (i = this._getMarkers().length - 1; i >= 0; i--) {
			if (this._getMarkers()[i].line < this._currentMarker.line) {
				return i;
			}
		}

		return -1;
	}

	private _findNextMark(xterm: Terminal): number {
		if (this._currentMarker === Boundary.Top) {
			return 0;
		} else if (this._currentMarker === Boundary.Bottom) {
			return this._getMarkers().length - 1;
		}

		let i;
		for (i = 0; i < this._getMarkers().length; i++) {
			if (this._getMarkers()[i].line > this._currentMarker.line) {
				return i;
			}
		}

		return this._getMarkers().length;
	}
}

registerThemingParticipant((theme: IColorTheme, collector: ICssStyleCollector) => {
	const focusBorderColor = theme.getColor(focusBorder);

	if (focusBorderColor) {
		collector.addRule(`.terminal-scroll-highlight { border-color: ${focusBorderColor.toString()}; } `);
	}
});

export function getLine(xterm: Terminal, marker: IMarker | Boundary): number {
	// Use the _second last_ row as the last row is likely the prompt
	if (marker === Boundary.Bottom) {
		return xterm.buffer.active.baseY + xterm.rows - 1;
	}

	if (marker === Boundary.Top) {
		return 0;
	}

	return marker.line;
}

export function selectLines(xterm: Terminal, start: IMarker | Boundary, end: IMarker | Boundary | null): void {
	if (end === null) {
		end = Boundary.Bottom;
	}

	let startLine = getLine(xterm, start);
	let endLine = getLine(xterm, end);

	if (startLine > endLine) {
		const temp = startLine;
		startLine = endLine;
		endLine = temp;
	}

	// Subtract a line as the marker is on the line the command run, we do not want the next
	// command in the selection for the current command
	endLine -= 1;

	xterm.selectLines(startLine, endLine);
}