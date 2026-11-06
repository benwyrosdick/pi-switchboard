/**
 * Conversation switchboard.
 *
 * Ctrl+\ toggles a side panel of conversations (Grok's agent dashboard).
 * Left at column 0 of the prompt opens the same panel (Claude Code's agents view).
 *
 * Pi runs one conversation at a time. Switching aborts an in-flight response
 * only after confirmation. Other conversations stay on disk.
 */

import { randomBytes } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join, basename, resolve } from "node:path";
import { createInterface } from "node:readline";

import { CustomEditor, type ExtensionAPI, type ExtensionCommandContext, type Theme, getAgentDir, SessionManager } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, type KeybindingsManager, type TUI } from "@earendil-works/pi-tui";

const COMMAND = "switchboard";
const STATE_VERSION = 1;
const MAX_OPEN = 30;
const MAX_RECENT = 20;

interface SessionInfo {
	path: string;
	id: string;
	cwd: string;
	name?: string;
	created: Date;
	modified: Date;
	messageCount: number;
	firstMessage: string;
}

interface ProjectState {
	open: string[];
	drafts: Record<string, string>;
}

interface BoardFile {
	version: number;
	projects: Record<string, ProjectState>;
}

type PanelResult = "cancel" | { action: "switch"; path: string } | { action: "new" };

type Row =
	| { kind: "header"; label: string }
	| { kind: "session"; session: SessionInfo; section: "open" | "recent" }
	| { kind: "new" };

let panelOpen = false;
let closePanel: ((result: PanelResult) => void) | null = null;
let openInFlight = false;
let notify: (message: string, level: "info" | "warning" | "error") => void = () => {};
const LEFT_ARROW_MARK = Symbol.for("pi-switchboard.left-arrow");

export default function (pi: ExtensionAPI) {
	pi.registerShortcut("ctrl+\\", {
		description: "Toggle the conversation switchboard",
		handler: async () => {
			requestOpen(pi);
		},
	});

	const openHandler = async (args: string, ctx: ExtensionCommandContext) => {
		if (ctx.mode !== "tui" || !ctx.hasUI) {
			ctx.ui.notify("Switchboard needs the interactive TUI", "error");
			return;
		}

		const verb = args.trim().toLowerCase();
		if (verb === "next" || verb === "prev") {
			await cycle(ctx, verb === "next" ? 1 : -1);
			return;
		}
		if (verb === "new") {
			await createConversation(ctx);
			return;
		}
		if (panelOpen) {
			closePanel?.("cancel");
			return;
		}

		await openPanel(pi, ctx);
	};

	pi.registerCommand(COMMAND, {
		description: "Open the conversation switchboard (next, prev, new)",
		handler: openHandler,
	});
	pi.registerCommand("conversations", {
		description: "Open the conversation switchboard",
		handler: openHandler,
	});

	pi.on("session_start", async (_event, ctx) => {
		notify = (message, level) => ctx.ui.notify(message, level);
		installLeftArrow(ctx, () => requestOpen(pi));
		await rememberCurrent(ctx);
		restoreDraft(ctx);
		updateStatus(ctx);
	});

	pi.on("input", async (_event, ctx) => {
		const path = ctx.sessionManager.getSessionFile();
		if (!path) return;
		const board = readBoard();
		const project = projectState(board, ctx.cwd);
		if (project.drafts[resolve(path)] === undefined) return;
		delete project.drafts[resolve(path)];
		writeBoard(board);
	});

	pi.on("session_info_changed", async (_event, ctx) => {
		updateStatus(ctx);
	});
}

function requestOpen(pi: ExtensionAPI): void {
	if (panelOpen) {
		closePanel?.("cancel");
		return;
	}
	if (openInFlight) return;
	openInFlight = true;
	try {
		// Public API returns void. The promise is caught inside Pi; chaining .catch crashes.
		const pending = pi.sendUserMessage(`/${COMMAND}`, { expandPromptTemplates: true }) as unknown;
		if (isPromise(pending)) {
			void pending.catch((error: unknown) => {
				notify(error instanceof Error ? error.message : String(error), "error");
			}).finally(() => {
				openInFlight = false;
			});
			return;
		}
	} catch (error) {
		notify(error instanceof Error ? error.message : String(error), "error");
	}
	openInFlight = false;
}

function isPromise(value: unknown): value is Promise<void> {
	return typeof value === "object" && value !== null && typeof (value as Promise<void>).then === "function";
}

function installLeftArrow(ctx: ExtensionCommandContext, open: () => void): void {
	const previous = ctx.ui.getEditorComponent();
	ctx.ui.setEditorComponent((tui, theme, keybindings) => {
		const editor = previous
			? previous(tui, theme, keybindings)
			: new CustomEditor(tui, theme, keybindings);
		if (typeof editor.handleInput !== "function" || Reflect.get(editor, LEFT_ARROW_MARK) === true) return editor;
		const original = editor.handleInput.bind(editor);
		editor.handleInput = (data: string) => {
			if (shouldOpenOnLeft(data, editor)) {
				open();
				return;
			}
			original(data);
		};
		Reflect.set(editor, LEFT_ARROW_MARK, true);
		return editor;
	});
}

function shouldOpenOnLeft(data: string, editor: { getText(): string; getCursor?(): { line: number; col: number }; isShowingAutocomplete?(): boolean }): boolean {
	if (!matchesKey(data, "left")) return false;
	if (editor.isShowingAutocomplete?.()) return false;
	const cursor = editor.getCursor?.() ?? (editor.getText().length === 0 ? { line: 0, col: 0 } : undefined);
	return cursor?.line === 0 && cursor.col === 0;
}

async function openPanel(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	panelOpen = true;
	parkDraft(ctx);
	try {
		const result = await ctx.ui.custom<PanelResult>(
			(tui, theme, keybindings, done) => {
				closePanel = done;
				return new SwitchboardPanel({
					tui,
					theme,
					keybindings,
					done,
					cwd: ctx.cwd,
					currentPath: ctx.sessionManager.getSessionFile() ?? undefined,
					busy: !ctx.isIdle(),
					onRename: (path, name) => renameSession(pi, ctx, path, name),
					onHide: (path) => hideSession(ctx.cwd, path),
				});
			},
			{
				overlay: true,
				overlayOptions: () => panelOverlayOptions(),
			},
		);
		if (!result || result === "cancel") return;
		if (result.action === "new") {
			await createConversation(ctx);
			return;
		}
		await switchTo(ctx, result.path);
	} finally {
		panelOpen = false;
		closePanel = null;
	}
}

function panelOverlayOptions() {
	const cols = process.stdout.columns || 80;
	const rows = process.stdout.rows || 24;
	if (cols < 72) {
		return { anchor: "center" as const, width: Math.max(36, cols - 4), maxHeight: Math.max(12, rows - 2) };
	}
	return {
		anchor: "left-center" as const,
		width: Math.min(52, Math.max(40, Math.floor(cols * 0.38))),
		maxHeight: Math.max(12, rows - 1),
		margin: 0,
	};
}

async function createConversation(ctx: ExtensionCommandContext): Promise<void> {
	if (!(await confirmIfBusy(ctx, "Start a new conversation?"))) return;
	const parentSession = ctx.sessionManager.getSessionFile() ?? undefined;
	const result = await ctx.newSession({
		parentSession,
		withSession: async (next) => {
			next.ui.notify("New conversation", "info");
		},
	});
	if (result.cancelled) ctx.ui.notify("New conversation cancelled", "warning");
}

async function switchTo(ctx: ExtensionCommandContext, sessionPath: string): Promise<void> {
	const current = ctx.sessionManager.getSessionFile();
	if (current && resolve(current) === resolve(sessionPath)) return;
	if (!existsSync(sessionPath)) {
		hideSession(ctx.cwd, sessionPath);
		ctx.ui.notify("That conversation is gone", "warning");
		return;
	}
	if (!(await confirmIfBusy(ctx, "Switch conversation?"))) return;
	parkDraft(ctx);
	const result = await ctx.switchSession(sessionPath, {
		withSession: async (next) => {
			const name = next.sessionManager.getSessionName();
			next.ui.notify(name ? `Switched to ${name}` : "Switched conversation", "info");
		},
	});
	if (result.cancelled) ctx.ui.notify("Switch cancelled", "warning");
}

async function cycle(ctx: ExtensionCommandContext, direction: 1 | -1): Promise<void> {
	const current = ctx.sessionManager.getSessionFile();
	if (!current) {
		ctx.ui.notify("This session is not saved", "warning");
		return;
	}
	const open = projectState(readBoard(), ctx.cwd).open.filter((path) => existsSync(path));
	if (!open.includes(resolve(current))) open.unshift(resolve(current));
	if (open.length < 2) {
		ctx.ui.notify("No other open conversation", "info");
		return;
	}
	const index = open.indexOf(resolve(current));
	const next = open[(index + direction + open.length) % open.length]!;
	await switchTo(ctx, next);
}

async function confirmIfBusy(ctx: ExtensionCommandContext, title: string): Promise<boolean> {
	if (ctx.isIdle()) return true;
	return ctx.ui.confirm(title, "The current response will be aborted.");
}

async function renameSession(pi: ExtensionAPI, ctx: ExtensionCommandContext, sessionPath: string, name: string): Promise<void> {
	const cleaned = name.replace(/[\r\n]+/g, " ").trim();
	if (!cleaned) return;
	const current = ctx.sessionManager.getSessionFile();
	if (current && resolve(current) === resolve(sessionPath)) {
		pi.setSessionName(cleaned);
		return;
	}
	await appendSessionName(sessionPath, cleaned);
}

function hideSession(cwd: string, sessionPath: string): void {
	const board = readBoard();
	const project = projectState(board, cwd);
	const target = resolve(sessionPath);
	project.open = project.open.filter((path) => path !== target);
	writeBoard(board);
}

async function rememberCurrent(ctx: ExtensionCommandContext): Promise<void> {
	const path = ctx.sessionManager.getSessionFile();
	if (!path) return;
	const board = readBoard();
	const project = projectState(board, ctx.cwd);
	const resolved = resolve(path);
	project.open = [resolved, ...project.open.filter((item) => item !== resolved)].slice(0, MAX_OPEN);
	writeBoard(board);
}

function parkDraft(ctx: ExtensionCommandContext): void {
	const path = ctx.sessionManager.getSessionFile();
	if (!path) return;
	const board = readBoard();
	const project = projectState(board, ctx.cwd);
	const text = ctx.ui.getEditorText();
	const key = resolve(path);
	if (text.length > 0) project.drafts[key] = text;
	else delete project.drafts[key];
	writeBoard(board);
}

function restoreDraft(ctx: ExtensionCommandContext): void {
	const path = ctx.sessionManager.getSessionFile();
	if (!path) return;
	if (ctx.ui.getEditorText().length > 0) return;
	const draft = projectState(readBoard(), ctx.cwd).drafts[resolve(path)];
	if (draft) ctx.ui.setEditorText(draft);
}

function updateStatus(ctx: ExtensionCommandContext): void {
	const path = ctx.sessionManager.getSessionFile();
	if (!path) {
		ctx.ui.setStatus("switchboard", undefined);
		return;
	}
	const open = projectState(readBoard(), ctx.cwd).open.filter((item) => existsSync(item) || resolve(item) === resolve(path));
	const index = Math.max(1, open.indexOf(resolve(path)) + 1);
	const name = ctx.sessionManager.getSessionName() ?? "untitled";
	const label = open.length > 1 ? `${index}/${open.length} ${truncatePlain(name, 24)}` : "← or ctrl+\\";
	ctx.ui.setStatus("switchboard", label);
}

class SwitchboardPanel {
	private tui: TUI;
	private theme: Theme;
	private keybindings: KeybindingsManager;
	private done: (result: PanelResult) => void;
	private cwd: string;
	private currentPath?: string;
	private busy: boolean;
	private onRename: (path: string, name: string) => Promise<void>;
	private onHide: (path: string) => void;

	private loading = true;
	private sessions: SessionInfo[] = [];
	private selected = 0;
	private filter = "";
	private filtering = false;
	private renaming = false;
	private renameText = "";
	private error: string | undefined;
	focused = false;

	constructor(options: {
		tui: TUI;
		theme: Theme;
		keybindings: KeybindingsManager;
		done: (result: PanelResult) => void;
		cwd: string;
		currentPath?: string;
		busy: boolean;
		onRename: (path: string, name: string) => Promise<void>;
		onHide: (path: string) => void;
	}) {
		this.tui = options.tui;
		this.theme = options.theme;
		this.keybindings = options.keybindings;
		this.done = options.done;
		this.cwd = options.cwd;
		this.currentPath = options.currentPath;
		this.busy = options.busy;
		this.onRename = options.onRename;
		this.onHide = options.onHide;
		void this.reload();
	}

	invalidate(): void {}

	handleInput(data: string): void {
		if (this.renaming) {
			this.handleRenameInput(data);
			this.tui.requestRender();
			return;
		}
		if (this.filtering && data.length === 1 && data.charCodeAt(0) >= 32 && !matchesKey(data, "escape")) {
			this.filter += data;
			this.clampSelection();
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "escape") || this.keybindings.matches(data, "tui.select.cancel") || matchesKey(data, "ctrl+\\") || matchesKey(data, "left")) {
			if (this.filtering && this.filter.length > 0 && matchesKey(data, "escape")) {
				this.filter = "";
				this.filtering = false;
				this.clampSelection();
				this.tui.requestRender();
				return;
			}
			this.done("cancel");
			return;
		}
		if (matchesKey(data, "backspace") && (this.filtering || this.filter.length > 0)) {
			this.filter = this.filter.slice(0, -1);
			if (this.filter.length === 0) this.filtering = false;
			this.clampSelection();
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "/") && !this.filtering) {
			this.filtering = true;
			this.tui.requestRender();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.up") || (!this.filtering && matchesKey(data, "k"))) {
			this.move(-1);
			return;
		}
		if (this.keybindings.matches(data, "tui.select.down") || (!this.filtering && matchesKey(data, "j"))) {
			this.move(1);
			return;
		}
		if (!this.filtering && /^[1-9]$/.test(data)) {
			const rows = this.selectableRows();
			const row = rows[Number(data) - 1];
			if (row) this.activate(row);
			return;
		}
		if (!this.filtering && (matchesKey(data, "n") || matchesKey(data, "ctrl+n"))) {
			this.done({ action: "new" });
			return;
		}
		if (!this.filtering && matchesKey(data, "r")) {
			const row = this.selectedRow();
			if (row?.kind === "session") {
				this.renaming = true;
				this.renameText = row.session.name ?? "";
				this.tui.requestRender();
			}
			return;
		}
		if (!this.filtering && matchesKey(data, "x")) {
			const row = this.selectedRow();
			if (row?.kind !== "session" || row.section !== "open") return;
			if (resolve(row.session.path) === this.currentResolved()) {
				this.error = "Can't hide the conversation you're in";
				this.tui.requestRender();
				return;
			}
			this.onHide(row.session.path);
			void this.reload();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.confirm") || matchesKey(data, "enter") || matchesKey(data, "return")) {
			const row = this.selectedRow();
			if (row) this.activate(row);
		}
	}

	render(width: number): string[] {
		const theme = this.theme;
		const inner = Math.max(24, width - 2);
		const all = this.rows();
		const selectable = all.filter((row) => row.kind !== "header");
		const rows = this.windowRows(all, selectable);
		const position = selectable.length === 0 ? "0/0" : `${Math.min(this.selected + 1, selectable.length)}/${selectable.length}`;
		const lines: string[] = [];
		const rule = (body: string) => theme.fg("border", "│") + fit(body, inner) + theme.fg("border", "│");

		lines.push(theme.fg("border", `╭${"─".repeat(inner)}╮`));
		lines.push(rule(spread(` ${theme.fg("accent", theme.bold("Conversations"))}`, theme.fg("dim", position), inner)));
		lines.push(rule(` ${theme.fg("dim", truncatePlain(basename(this.cwd) || this.cwd, inner - 2))}`));
		if (this.filtering || this.filter.length > 0) {
			lines.push(rule(` ${theme.fg("accent", "/")} ${this.filter}${this.filtering ? theme.fg("accent", "▏") : ""}`));
		}
		if (this.busy) lines.push(rule(` ${theme.fg("warning", "response in progress — switching aborts it")}`));
		if (this.error) lines.push(rule(` ${theme.fg("error", truncatePlain(this.error, inner - 2))}`));
		lines.push(rule(""));

		if (this.loading) {
			lines.push(rule(` ${theme.fg("dim", "Loading conversations…")}`));
		} else if (selectable.length === 0) {
			lines.push(rule(` ${theme.fg("dim", "No conversations yet")}`));
		} else {
			for (const row of rows) {
				const index = selectable.indexOf(row);
				lines.push(rule(this.renderRow(row, inner, index >= 0 && index === this.selected, index)));
			}
		}

		lines.push(rule(""));
		if (this.renaming) {
			lines.push(rule(` ${theme.fg("accent", "rename")} ${this.renameText}${theme.fg("accent", "▏")}`));
			lines.push(rule(` ${theme.fg("dim", "enter save · esc cancel")}`));
		} else {
			lines.push(rule(` ${theme.fg("dim", "⏎ open  n new  r rename  x hide")}`));
			lines.push(rule(` ${theme.fg("dim", "← or ctrl+\\ close  / filter")}`));
		}
		lines.push(theme.fg("border", `╰${"─".repeat(inner)}╯`));
		return lines.map((line) => truncateToWidth(line, width));
	}

	private renderRow(row: Row, inner: number, selected: boolean, index: number): string {
		const theme = this.theme;
		if (row.kind === "header") return ` ${theme.fg("dim", row.label)}`;
		if (row.kind === "new") {
			const text = ` ${selected ? theme.fg("accent", "▸") : " "} ${theme.fg("accent", "+ New conversation")}`;
			return selected ? theme.bg("selectedBg", fit(text, inner)) : text;
		}
		const current = this.currentResolved() === resolve(row.session.path);
		const mark = current ? theme.fg("accent", "●") : theme.fg("dim", "○");
		const title = displayTitle(row.session);
		const when = relTime(row.session.modified);
		const indexLabel = index >= 0 && index < 9 ? theme.fg("dim", `${index + 1} `) : "  ";
		const pointer = selected ? theme.fg("accent", "▸") : " ";
		const prefix = ` ${pointer}${mark} ${indexLabel}`;
		const meta = theme.fg("dim", when);
		const room = Math.max(8, inner - visibleWidth(prefix) - visibleWidth(meta) - 1);
		const padded = fit(`${prefix}${truncatePlain(title, room)} ${meta}`, inner);
		return selected ? theme.bg("selectedBg", padded) : padded;
	}

	private windowRows(all: Row[], selectable: Row[]): Row[] {
		const budget = Math.max(4, (process.stdout.rows || 24) - 12);
		const selected = selectable[this.selected];
		const index = selected ? all.indexOf(selected) : 0;
		const start = index >= budget ? index - budget + 1 : 0;
		return all.slice(start, start + budget);
	}

	private rows(): Row[] {
		const query = this.filter.trim().toLowerCase();
		const current = this.currentResolved();
		const openPaths = new Set(projectState(readBoard(), this.cwd).open);
		if (current) openPaths.add(current);
		const matches = (session: SessionInfo) => {
			if (!query) return true;
			const haystack = `${session.name ?? ""} ${session.firstMessage}`.toLowerCase();
			return haystack.includes(query);
		};
		const open = this.sessions.filter((session) => openPaths.has(resolve(session.path)) && matches(session));
		const recent = this.sessions.filter((session) => !openPaths.has(resolve(session.path)) && matches(session)).slice(0, MAX_RECENT);
		const rows: Row[] = [];
		if (open.length > 0) {
			rows.push({ kind: "header", label: "OPEN" });
			for (const session of open) rows.push({ kind: "session", session, section: "open" });
		}
		if (recent.length > 0) {
			rows.push({ kind: "header", label: "RECENT" });
			for (const session of recent) rows.push({ kind: "session", session, section: "recent" });
		}
		if (!query || "new conversation".includes(query)) rows.push({ kind: "new" });
		return rows;
	}

	private selectableRows(): Row[] {
		return this.rows().filter((row) => row.kind !== "header");
	}

	private selectedRow(): Row | undefined {
		return this.selectableRows()[this.selected];
	}

	private move(direction: -1 | 1): void {
		const count = this.selectableRows().length;
		if (count === 0) return;
		this.selected = (this.selected + direction + count) % count;
		this.tui.requestRender();
	}

	private clampSelection(): void {
		const count = this.selectableRows().length;
		if (count === 0) this.selected = 0;
		else if (this.selected >= count) this.selected = count - 1;
	}

	private activate(row: Row): void {
		if (row.kind === "new") {
			this.done({ action: "new" });
			return;
		}
		if (row.kind !== "session") return;
		if (this.currentResolved() === resolve(row.session.path)) {
			this.done("cancel");
			return;
		}
		this.done({ action: "switch", path: row.session.path });
	}

	private handleRenameInput(data: string): void {
		if (matchesKey(data, "escape")) {
			this.renaming = false;
			return;
		}
		if (matchesKey(data, "enter") || matchesKey(data, "return")) {
			const row = this.selectedRow();
			const name = this.renameText.trim();
			this.renaming = false;
			if (row?.kind === "session" && name) {
				void this.onRename(row.session.path, name).then(() => this.reload()).catch((error: unknown) => {
					this.error = error instanceof Error ? error.message : String(error);
					this.tui.requestRender();
				});
			}
			return;
		}
		if (matchesKey(data, "backspace")) {
			this.renameText = this.renameText.slice(0, -1);
			return;
		}
		if (data.length === 1 && data.charCodeAt(0) >= 32) this.renameText += data;
	}

	private async reload(): Promise<void> {
		this.loading = this.sessions.length === 0;
		this.error = undefined;
		try {
			this.sessions = await loadSessions(this.cwd, this.currentPath);
			const current = this.currentResolved();
			const selectable = this.selectableRows();
			const index = selectable.findIndex((row) => row.kind === "session" && resolve(row.session.path) === current);
			if (index >= 0) this.selected = index;
			this.clampSelection();
		} catch (error) {
			this.error = error instanceof Error ? error.message : String(error);
		} finally {
			this.loading = false;
			this.tui.requestRender();
		}
	}

	private currentResolved(): string | undefined {
		return this.currentPath ? resolve(this.currentPath) : undefined;
	}
}

async function loadSessions(cwd: string, currentPath?: string): Promise<SessionInfo[]> {
	const listed = (await SessionManager.list(cwd)) as SessionInfo[];
	const byPath = new Map<string, SessionInfo>();
	for (const session of listed) byPath.set(resolve(session.path), session);
	if (currentPath && !byPath.has(resolve(currentPath)) && existsSync(currentPath)) {
		byPath.set(resolve(currentPath), {
			path: currentPath,
			id: "",
			cwd,
			created: new Date(),
			modified: new Date(),
			messageCount: 0,
			firstMessage: "(current)",
		});
	}
	const open = projectState(readBoard(), cwd).open;
	const rank = new Map(open.map((path, index) => [path, index]));
	return [...byPath.values()].sort((a, b) => {
		const ar = rank.get(resolve(a.path));
		const br = rank.get(resolve(b.path));
		if (ar !== undefined || br !== undefined) return (ar ?? 999) - (br ?? 999);
		return b.modified.getTime() - a.modified.getTime();
	});
}

async function appendSessionName(sessionPath: string, name: string): Promise<void> {
	const ids = new Set<string>();
	let parentId: string | null = null;
	const stream = createReadStream(sessionPath, { encoding: "utf8" });
	const lines = createInterface({ input: stream, crlfDelay: Infinity });
	for await (const line of lines) {
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line) as { type?: string; id?: string };
			if (entry.id) ids.add(entry.id);
			if (entry.type && entry.type !== "session" && entry.id) parentId = entry.id;
		} catch {
			// Ignore a corrupt trailing line; Pi skips those too.
		}
	}
	let id = randomBytes(4).toString("hex");
	while (ids.has(id)) id = randomBytes(4).toString("hex");
	const entry = {
		type: "session_info",
		id,
		parentId,
		timestamp: new Date().toISOString(),
		name,
	};
	appendFileSync(sessionPath, `${JSON.stringify(entry)}\n`, "utf8");
}

function displayTitle(session: SessionInfo): string {
	const name = session.name?.trim();
	if (name) return name;
	const first = session.firstMessage.replace(/\s+/g, " ").trim();
	if (!first || first === "(no messages)") return "untitled";
	return first;
}

function relTime(date: Date): string {
	const seconds = Math.max(0, Date.now() - date.getTime()) / 1000;
	if (seconds < 45) return "now";
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
	if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
	if (seconds < 86400 * 14) return `${Math.floor(seconds / 86400)}d`;
	return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function truncatePlain(text: string, width: number): string {
	if (width <= 0) return "";
	if (visibleWidth(text) <= width) return text;
	if (width <= 1) return truncateToWidth(text, width);
	return truncateToWidth(text, width - 1) + "…";
}

function fit(text: string, width: number): string {
	const truncated = truncateToWidth(text, width);
	const gap = width - visibleWidth(truncated);
	return gap > 0 ? truncated + " ".repeat(gap) : truncated;
}

function spread(left: string, right: string, width: number): string {
	const gap = width - visibleWidth(left) - visibleWidth(right);
	if (gap < 1) return truncateToWidth(left, width);
	return left + " ".repeat(gap) + right;
}

function statePath(): string {
	return join(getAgentDir(), "switchboard.json");
}

function readBoard(): BoardFile {
	const path = statePath();
	if (!existsSync(path)) return { version: STATE_VERSION, projects: {} };
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as BoardFile;
		if (!parsed || typeof parsed !== "object" || !parsed.projects) return { version: STATE_VERSION, projects: {} };
		return parsed;
	} catch {
		return { version: STATE_VERSION, projects: {} };
	}
}

function writeBoard(board: BoardFile): void {
	const path = statePath();
	mkdirSync(dirname(path), { recursive: true });
	const temp = `${path}.${process.pid}.tmp`;
	writeFileSync(temp, JSON.stringify(board, null, 2) + "\n", "utf8");
	renameSync(temp, path);
}

function projectState(board: BoardFile, cwd: string): ProjectState {
	const key = resolve(cwd);
	const existing = board.projects[key];
	if (existing) {
		existing.open = (existing.open ?? []).map((path) => resolve(path)).filter((path, index, all) => all.indexOf(path) === index);
		existing.drafts ??= {};
		return existing;
	}
	const created: ProjectState = { open: [], drafts: {} };
	board.projects[key] = created;
	return created;
}
