import React, { useEffect, useMemo, useState } from "react";
import ReactFlow, {
    Background, Controls, MiniMap, useNodesState, useEdgesState, Position
} from "reactflow";
import "reactflow/dist/style.css";
import Papa from "papaparse";
import dagre from "dagre";

/** ---------- Tunables ---------- */
const NODE_W = 320;          // approximate card width for layout
const NODE_H = 130;          // approximate card height for layout
const RANK_SEP = 200;        // horizontal gap between dependency layers (LR)
const NODE_SEP = 80;         // vertical gap between siblings
const EDGE_SEP = 20;         // extra spacing for edges

const STAGE_ORDER = ["Setup", "Start", "Early", "Late"];

/** ---------- Types ---------- */
type Row = {
    id: string;
    title: string;
    section?: string;
    stage?: "Setup" | "Start" | "Early" | "Late" | string;
    description?: string;
    priority?: string | number;
    depends_on?: string;  // pipe-delimited
    status?: "todo" | "done" | string;
    tags?: string;
};

const localKey = (csvUrl: string) => `stellaris-flow-status:${csvUrl}`;

export default function Flowchart({ csvUrl = "/stellaris_synth_fertility_flow.csv" }: { csvUrl?: string }) {
    const [rawRows, setRawRows] = useState<Row[]>([]);
    const [onlyNextActionable, setOnlyNextActionable] = useState(false);
    const [filterStage, setFilterStage] = useState<string>("All");
    const [layoutDir, setLayoutDir] = useState<"LR" | "TB">("LR"); // horizontal default

    const [nodes, setNodes, onNodesChange] = useNodesState([]);
    const [edges, setEdges, onEdgesChange] = useEdgesState([]);

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

    const buildGraph = useMemo(() => {
        const depsOf = (r: Row) =>
            (r.depends_on || "")
                .split("|")
                .map(s => s.trim())
                .filter(Boolean);

        const completed = new Set(rawRows.filter(r => r.status === "done").map(r => r.id));

        // Actionable = todo and all deps satisfied
        const actionable = new Set(
            rawRows
                .filter(r => (r.status !== "done") && depsOf(r).every(d => completed.has(d)))
                .map(r => r.id)
        );

        // Stage filter
        const visibleRows = rawRows.filter(r =>
            (filterStage === "All" || r.stage === filterStage) &&
            (!onlyNextActionable || actionable.has(r.id))
        );

        // Build edges from deps (only if both ends visible)
        const visibleIds = new Set(visibleRows.map(r => r.id));
        const edgesBuilt = visibleRows.flatMap(r =>
            depsOf(r)
                .filter(dep => visibleIds.has(dep))
                .map(dep => ({
                    id: `${dep}->${r.id}`,
                    source: dep,
                    target: r.id,
                }))
        );

        // Initial nodes (positions filled after layout)
        const nodesBuilt = visibleRows.map((r) => ({
            id: r.id,
            position: { x: 0, y: 0 },
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
    }, [rawRows, onlyNextActionable, filterStage]);

    // Apply Dagre layout whenever graph or orientation changes
    useEffect(() => {
        const { nodesBuilt, edgesBuilt } = buildGraph;

        // Configure dagre
        const isHorizontal = layoutDir === "LR";
        const g = new dagre.graphlib.Graph();
        g.setGraph({
            rankdir: layoutDir, // "LR" horizontal, "TB" vertical
            ranksep: RANK_SEP,
            nodesep: NODE_SEP,
            edgesep: EDGE_SEP,
            marginx: 40,
            marginy: 40
        });
        g.setDefaultEdgeLabel(() => ({}));

        // Add nodes with sizes
        nodesBuilt.forEach(n => {
            g.setNode(n.id, { width: NODE_W, height: NODE_H });
        });

        // Add edges
        edgesBuilt.forEach(e => g.setEdge(e.source, e.target));

        dagre.layout(g);

        // Map dagre positions back to React Flow nodes/edges
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
    }, [buildGraph, layoutDir, setNodes, setEdges]);

    return (
        <div style={{ height: "80vh", width: "100%", display: "grid", gridTemplateRows: "auto 1fr", gap: 12 }}>
            {/* Controls */}
            <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                <strong>Flow:</strong>
                <select value={filterStage} onChange={e => setFilterStage(e.target.value)}>
                    {["All", ...STAGE_ORDER].map(s => <option key={s} value={s}>{s}</option>)}
                </select>
                <label style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
                    <input type="checkbox" checked={onlyNextActionable} onChange={e => setOnlyNextActionable(e.target.checked)} />
                    Only next actionable
                </label>

                <span style={{ marginLeft: 16 }}>Layout:</span>
                <select value={layoutDir} onChange={(e) => setLayoutDir(e.target.value as "LR" | "TB")}>
                    <option value="LR">Horizontal (left → right)</option>
                    <option value="TB">Vertical (top → bottom)</option>
                </select>

                <a
                    href={csvUrl}
                    download
                    style={{ marginLeft: "auto", fontSize: 12, textDecoration: "underline" }}
                    title="Download current CSV (original file)">
                    Download CSV
                </a>
            </div>

            {/* Canvas */}
            <div style={{ border: "1px solid #eee", borderRadius: 12, overflow: "hidden" }}>
                <ReactFlow
                    nodes={nodes}
                    edges={edges}
                    onNodesChange={onNodesChange}
                    onEdgesChange={onEdgesChange}
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
