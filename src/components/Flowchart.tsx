import React, { useEffect, useMemo, useRef, useState } from "react";
import ReactFlow, {
    Background, Controls, MiniMap, useNodesState, useEdgesState, Position
} from "reactflow";
import type { ReactFlowInstance } from "reactflow";
import "reactflow/dist/style.css";
import Papa from "papaparse";
import dagre from "dagre";

/** ---------- Layout tunables ---------- */
const NODE_W = 320;
const NODE_H = 130;
const RANK_SEP = 200;   // horizontal gap between dependency layers (LR)
const NODE_SEP = 80;    // vertical gap between siblings
const EDGE_SEP = 20;

const STAGE_ORDER = ["Setup", "Start", "Early", "Late"];

type Row = {
    id: string;
    title: string;
    section?: string;
    stage?: "Setup" | "Start" | "Early" | "Late" | string;
    description?: string;
    priority?: string | number;
    depends_on?: string;  // pipe-delimited
    status?: "todo" | "done" | string;
    tags?: string;        // pipe-delimited
};

const localKey = (csvUrl: string) => `stellaris-flow-status:${csvUrl}`;
const ci = (s?: string) => (s || "").toLowerCase();
const list = (s?: string) => (s || "").split("|").map(t => t.trim()).filter(Boolean);

export default function Flowchart({ csvUrl = "/stellaris_synth_fertility_flow.csv" }: { csvUrl?: string }) {
    const [rawRows, setRawRows] = useState<Row[]>([]);
    const [layoutDir, setLayoutDir] = useState<"LR" | "TB">("LR"); // Horizontal default
    const [onlyNextActionable, setOnlyNextActionable] = useState(false);

    // --- search + filters ---
    const [query, setQuery] = useState("");
    const [statusFilter, setStatusFilter] = useState<"all" | "todo" | "done">("all");
    const [selectedStages, setSelectedStages] = useState<string[]>([...STAGE_ORDER]);
    const [selectedSections, setSelectedSections] = useState<string[]>([]);
    const [selectedTags, setSelectedTags] = useState<string[]>([]);

    const [nodes, setNodes, onNodesChange] = useNodesState([]);
    const [edges, setEdges, onEdgesChange] = useEdgesState([]);

    // --- fullscreen ---
    const containerRef = useRef<HTMLDivElement>(null);
    const [isFullscreen, setIsFullscreen] = useState(false);
    const rfInstanceRef = useRef<ReactFlowInstance | null>(null);

    const requestFs = async () => {
        const el = containerRef.current;
        if (!el) return;
        if (!document.fullscreenElement) {
            // @ts-ignore older Safari
            await (el.requestFullscreen?.() || el.webkitRequestFullscreen?.());
        } else {
            await document.exitFullscreen?.();
        }
    };

    useEffect(() => {
        const onFsChange = () => {
            const active = !!document.fullscreenElement && document.fullscreenElement === containerRef.current;
            setIsFullscreen(active);
            // Give the browser a tick to resize, then refit
            setTimeout(() => rfInstanceRef.current?.fitView({ padding: 0.2 }), 80);
        };
        document.addEventListener("fullscreenchange", onFsChange);
        // @ts-ignore older Safari
        document.addEventListener("webkitfullscreenchange", onFsChange);
        return () => {
            document.removeEventListener("fullscreenchange", onFsChange);
            // @ts-ignore
            document.removeEventListener("webkitfullscreenchange", onFsChange);
        };
    }, []);

    // Optional: Shift+F toggles fullscreen
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key.toLowerCase() === "f" && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
                e.preventDefault();
                requestFs();
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, []);

    // Load CSV
    useEffect(() => {
        Papa.parse<Row>(csvUrl, {
            header: true,
            download: true,
            skipEmptyLines: true,
            complete: (res) => {
                const rows = (res.data || []).map((r) => ({
                    ...r,
                    id: (r.id || "").trim(),
                    title: (r.title || "").trim(),
                    stage: (r.stage || "Unsorted").trim(),
                    status: (r.status || "todo").trim()
                }));
                const saved = JSON.parse(localStorage.getItem(localKey(csvUrl)) || "{}");
                const merged = rows.map(r => saved[r.id] ? { ...r, status: saved[r.id] } : r);
                setRawRows(merged);
            }
        });
    }, [csvUrl]);

    // Persist status
    useEffect(() => {
        if (!rawRows.length) return;
        const map: Record<string, string> = {};
        rawRows.forEach(r => { map[r.id] = r.status || "todo"; });
        localStorage.setItem(localKey(csvUrl), JSON.stringify(map));
    }, [rawRows, csvUrl]);

    // Unique sections & tags (for chips)
    const allSections = useMemo(() => {
        const s = Array.from(new Set(rawRows.map(r => r.section || "General"))).sort();
        return s;
    }, [rawRows]);

    const allTags = useMemo(() => {
        const tags = new Set<string>();
        rawRows.forEach(r => list(r.tags).forEach(t => tags.add(t)));
        return Array.from(tags).sort();
    }, [rawRows]);

    useEffect(() => {
        if (rawRows.length && selectedSections.length === 0) {
            setSelectedSections(allSections);
        }
    }, [rawRows, allSections, selectedSections.length]);

    const toggle = (arr: string[], value: string, onChange: (v: string[]) => void) => {
        onChange(arr.includes(value) ? arr.filter(x => x !== value) : [...arr, value]);
    };

    /** Build graph with filters */
    const buildGraph = useMemo(() => {
        const depsOf = (r: Row) => list(r.depends_on);
        const completed = new Set(rawRows.filter(r => r.status === "done").map(r => r.id));
        const actionable = new Set(
            rawRows
                .filter(r => (r.status !== "done") && depsOf(r).every(d => completed.has(d)))
                .map(r => r.id)
        );

        const q = ci(query);
        const okStatus = (r: Row) =>
            statusFilter === "all" ? true :
                statusFilter === "todo" ? r.status !== "done" :
                    r.status === "done";
        const okStage = (r: Row) => selectedStages.includes(r.stage || "");
        const okSection = (r: Row) => selectedSections.includes(r.section || "General");
        const okTags = (r: Row) => {
            if (!selectedTags.length) return true;
            const tags = list(r.tags);
            return tags.some(t => selectedTags.includes(t));
        };
        const okSearch = (r: Row) => {
            if (!q) return true;
            const hay = [r.title, r.description, r.section, r.stage, r.tags].map(ci).join(" ");
            return hay.includes(q);
        };

        let visibleRows = rawRows.filter(r =>
            okStatus(r) && okStage(r) && okSection(r) && okTags(r) && okSearch(r)
        );
        if (onlyNextActionable) {
            visibleRows = visibleRows.filter(r => actionable.has(r.id));
        }

        const visibleIds = new Set(visibleRows.map(r => r.id));
        const edgesBuilt = visibleRows.flatMap(r =>
            depsOf(r)
                .filter(dep => visibleIds.has(dep))
                .map(dep => ({ id: `${dep}->${r.id}`, source: dep, target: r.id }))
        );

        const nodesBuilt = visibleRows.map((r) => ({
            id: r.id,
            position: { x: 0, y: 0 }, // will be set by Dagre
            data: {
                label: (
                    <div className="rounded-xl px-3 py-2 text-sm"
                        style={{
                            border: "1px solid var(--border, #ddd)",
                            background: r.status === "done" ? "rgba(160, 220, 180, .28)" : "white"
                        }}>
                        <div style={{ fontWeight: 600, textDecoration: r.status === "done" ? "line-through" : "none" }}>
                            {r.title}
                        </div>
                        <div className="opacity-70">{r.section || "General"} • {r.stage}</div>
                        {!!r.description && <div className="mt-1 text-xs">{r.description}</div>}
                        <div className="mt-2 flex items-center gap-2">
                            <label className="flex items-center gap-1 cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={r.status === "done"}
                                    onChange={(e) => {
                                        const next = rawRows.map(rr => rr.id === r.id ? { ...rr, status: e.target.checked ? "done" : "todo" } : rr);
                                        setRawRows(next);
                                    }}
                                />
                                <span className="text-xs">Completed</span>
                            </label>
                            {r.priority && <span className="text-[10px] px-1.5 py-0.5 rounded bg-black/5">P{r.priority}</span>}
                        </div>
                    </div>
                )
            },
            style: {
                width: NODE_W,
                borderRadius: 14,
                border: "none",
                boxShadow: "0 2px 12px rgba(0,0,0,.08)"
            },
            draggable: true,
            selectable: true,
            className: `stage-${(r.stage || "").toLowerCase()}`
        }));

        return { nodesBuilt, edgesBuilt };
    }, [rawRows, query, statusFilter, selectedStages, selectedSections, selectedTags, onlyNextActionable]);

    // Apply Dagre layout
    useEffect(() => {
        const { nodesBuilt, edgesBuilt } = buildGraph;
        const isHorizontal = layoutDir === "LR";

        const g = new dagre.graphlib.Graph();
        g.setGraph({
            rankdir: layoutDir,      // "LR" horizontal, "TB" vertical
            ranksep: RANK_SEP,
            nodesep: NODE_SEP,
            edgesep: EDGE_SEP,
            marginx: 40,
            marginy: 40
        });
        g.setDefaultEdgeLabel(() => ({}));

        nodesBuilt.forEach(n => g.setNode(n.id, { width: NODE_W, height: NODE_H }));
        edgesBuilt.forEach(e => g.setEdge(e.source, e.target));
        dagre.layout(g);

        const laidOutNodes = nodesBuilt.map(n => {
            const { x, y } = g.node(n.id);
            return {
                ...n,
                position: { x: x - NODE_W / 2, y: y - NODE_H / 2 },
                sourcePosition: isHorizontal ? Position.Right : Position.Bottom,
                targetPosition: isHorizontal ? Position.Left : Position.Top,
            };
        });

        const laidOutEdges = edgesBuilt.map(e => ({
            ...e,
            animated: true,
            style: { strokeWidth: 1.5 }
        }));

        setNodes(laidOutNodes);
        setEdges(laidOutEdges);

        // Keep view tidy after any relayout
        setTimeout(() => rfInstanceRef.current?.fitView({ padding: 0.2 }), 0);
    }, [buildGraph, layoutDir, setNodes, setEdges]);

    const allStages = STAGE_ORDER;

    return (
        <div style={{ height: "80vh", width: "100%", display: "grid", gridTemplateRows: "auto auto 1fr", gap: 10 }}>
            {/* === FILTER BAR === */}
            <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search title/description/section/tags…"
                    style={{ padding: "8px 10px", borderRadius: 10, border: "1px solid #ddd", minWidth: 280 }}
                />

                <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                    Status:
                    <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as any)}>
                        <option value="all">All</option>
                        <option value="todo">To-do</option>
                        <option value="done">Done</option>
                    </select>
                </label>

                <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                    Only next actionable
                    <input type="checkbox" checked={onlyNextActionable} onChange={(e) => setOnlyNextActionable(e.target.checked)} />
                </label>

                <span style={{ marginLeft: "auto" }}>Layout:</span>
                <select value={layoutDir} onChange={(e) => setLayoutDir(e.target.value as "LR" | "TB")}>
                    <option value="LR">Horizontal</option>
                    <option value="TB">Vertical</option>
                </select>

                {/* Fullscreen button in the toolbar */}
                <button
                    type="button"
                    onClick={requestFs}
                    style={{
                        marginLeft: 8,
                        fontSize: 12,
                        padding: "6px 10px",
                        border: "1px solid #ddd",
                        borderRadius: 8,
                        background: "white",
                        cursor: "pointer"
                    }}
                    title="Shift+F to toggle fullscreen"
                >
                    {isFullscreen ? "Exit Fullscreen" : "Fullscreen"}
                </button>

                <a href={csvUrl} download style={{ fontSize: 12, textDecoration: "underline" }}>Download CSV</a>
            </div>

            {/* === CHIP FILTERS === */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                {/* Stages */}
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <strong>Stage:</strong>
                    {allStages.map(s => (
                        <label key={s} style={chipStyle(selectedStages.includes(s))}>
                            <input
                                type="checkbox"
                                checked={selectedStages.includes(s)}
                                onChange={() => toggle(selectedStages, s, setSelectedStages)}
                                style={{ marginRight: 6 }}
                            />
                            {s}
                        </label>
                    ))}
                </div>

                {/* Sections */}
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <strong>Section:</strong>
                    <button type="button" onClick={() => setSelectedSections(allSections)} style={miniBtn} title="Select all">All</button>
                    <button type="button" onClick={() => setSelectedSections([])} style={miniBtn} title="Clear">None</button>
                    {allSections.map(sec => (
                        <label key={sec} style={chipStyle(selectedSections.includes(sec))}>
                            <input
                                type="checkbox"
                                checked={selectedSections.includes(sec)}
                                onChange={() => toggle(selectedSections, sec, setSelectedSections)}
                                style={{ marginRight: 6 }}
                            />
                            {sec}
                        </label>
                    ))}
                </div>

                {/* Tags */}
                <div style={{ gridColumn: "1 / -1", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <strong>Tags:</strong>
                    <button type="button" onClick={() => setSelectedTags([])} style={miniBtn}>Clear</button>
                    {allTags.map(tag => (
                        <label key={tag} style={chipStyle(selectedTags.includes(tag))}>
                            <input
                                type="checkbox"
                                checked={selectedTags.includes(tag)}
                                onChange={() => toggle(selectedTags, tag, setSelectedTags)}
                                style={{ marginRight: 6 }}
                            />
                            {tag}
                        </label>
                    ))}
                </div>
            </div>

            {/* === CANVAS (fullscreen target) === */}
            <div
                ref={containerRef}
                style={{
                    border: isFullscreen ? "none" : "1px solid #eee",
                    borderRadius: isFullscreen ? 0 : 12,
                    overflow: "hidden",
                    position: "relative",
                    height: "100%",
                    background: "white"
                }}
            >
                {/* Floating exit button while in fullscreen */}
                {isFullscreen && (
                    <button
                        type="button"
                        onClick={requestFs}
                        style={{
                            position: "absolute",
                            top: 10,
                            right: 10,
                            zIndex: 5,
                            fontSize: 12,
                            padding: "6px 10px",
                            border: "1px solid #ddd",
                            borderRadius: 8,
                            background: "white",
                            cursor: "pointer",
                            boxShadow: "0 2px 8px rgba(0,0,0,.12)"
                        }}
                        title="Exit fullscreen (Shift+F)"
                    >
                        Exit Fullscreen
                    </button>
                )}

                <ReactFlow
                    nodes={nodes}
                    edges={edges}
                    onNodesChange={onNodesChange}
                    onEdgesChange={onEdgesChange}
                    onInit={(inst) => { rfInstanceRef.current = inst; }}
                    fitView
                    fitViewOptions={{ padding: 0.2 }}
                >
                    <MiniMap pannable zoomable />
                    <Controls />
                    <Background gap={16} />
                </ReactFlow>
            </div>
        </div>
    );
}

/** tiny styles */
const chipStyle = (active: boolean): React.CSSProperties => ({
    display: "inline-flex",
    alignItems: "center",
    padding: "6px 10px",
    borderRadius: 999,
    border: "1px solid #ddd",
    background: active ? "rgba(0,0,0,.06)" : "white",
    cursor: "pointer",
    fontSize: 12
});
const miniBtn: React.CSSProperties = {
    fontSize: 12,
    padding: "4px 8px",
    border: "1px solid #ddd",
    borderRadius: 8,
    background: "white",
    cursor: "pointer"
};
