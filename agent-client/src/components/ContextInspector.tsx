"use client";

import React, { useState, useMemo } from "react";
import { useAgent } from "../context/agent-context";
import { computeJsonDiff, DiffNode } from "../lib/diff-engine";

// ── Recursive Lazy Tree Node Component ────────────────────────

interface TreeNodeProps {
  node: DiffNode;
  defaultExpanded?: boolean;
}

const TreeNode: React.FC<TreeNodeProps> = ({ node, defaultExpanded = false }) => {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);
  
  const hasChildren = node.children && node.children.length > 0;
  const isArray = Array.isArray(node.oldVal ?? node.newVal);

  const toggleExpand = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (hasChildren) {
      setIsExpanded(!isExpanded);
    }
  };

  const getClassNameForType = (type: string) => {
    switch (type) {
      case "added":
        return "diff-node-added";
      case "removed":
        return "diff-node-removed";
      case "updated":
        return "diff-node-updated";
      default:
        return "";
    }
  };

  const renderValue = (val: unknown) => {
    if (val === null) return <span className="tree-value null">null</span>;
    if (typeof val === "string") return <span className="tree-value string">&quot;{val}&quot;</span>;
    if (typeof val === "number") return <span className="tree-value number">{val}</span>;
    if (typeof val === "boolean") return <span className="tree-value boolean">{val.toString()}</span>;
    return <span className="tree-value">{JSON.stringify(val)}</span>;
  };

  return (
    <div className={`tree-node ${getClassNameForType(node.type)}`}>
      <div className="tree-node-content" onClick={toggleExpand}>
        {hasChildren ? (
          <span className={`tree-toggle-icon ${isExpanded ? "expanded" : ""}`}>
            ▶
          </span>
        ) : (
          <span style={{ width: "12px", display: "inline-block" }} />
        )}
        
        {node.key && (
          <>
            <span className="tree-key">{node.key}</span>
            <span className="tree-colon">: </span>
          </>
        )}

        {hasChildren ? (
          <span style={{ color: "var(--text-muted)", fontSize: "0.78rem" }}>
            {isArray ? `Array[${node.children!.length}] [` : `Object {`}
            {!isExpanded && (isArray ? " ... ]" : " ... }")}
          </span>
        ) : (
          <>
            {node.type === "updated" ? (
              <>
                <span className="diff-old-value">{JSON.stringify(node.oldVal)}</span>
                <span className="diff-new-value">→ {JSON.stringify(node.newVal)}</span>
              </>
            ) : (
              renderValue(node.type === "removed" ? node.oldVal : node.newVal)
            )}
          </>
        )}
      </div>

      {/* Lazy Rendering: Children are ONLY rendered to DOM when expanded */}
      {isExpanded && hasChildren && (
        <div style={{ paddingLeft: "8px", borderLeft: "1px dashed var(--border-color)", margin: "2px 0 2px 4px" }}>
          {node.children!.map((childNode, index) => (
            <TreeNode key={`${childNode.key}-${index}`} node={childNode} />
          ))}
          <div style={{ color: "var(--text-muted)", fontSize: "0.78rem", marginLeft: "16px" }}>
            {isArray ? "]" : "}"}
          </div>
        </div>
      )}
    </div>
  );
};

// ── Main Context Inspector Panel ──────────────────────────────

export const ContextInspector: React.FC = () => {
  const { snapshots, selectedIndex, activeContextId, setSelectedIndex } = useAgent();

  const history = useMemo(() => {
    if (!activeContextId) return [];
    return snapshots[activeContextId] || [];
  }, [snapshots, activeContextId]);

  const index = useMemo(() => {
    if (!activeContextId) return 0;
    return selectedIndex[activeContextId] ?? 0;
  }, [selectedIndex, activeContextId]);

  const diffNode = useMemo((): DiffNode | null => {
    if (history.length === 0) return null;
    const current = history[index];
    const previous = index > 0 ? history[index - 1] : null;
    
    // Diff current snapshot against previous snapshot
    return computeJsonDiff(previous || {}, current, "root");
  }, [history, index]);

  if (!activeContextId || history.length === 0 || !diffNode) {
    return (
      <div className="panel context-panel panel-last">
        <div className="panel-header">
          <span className="panel-title">Context Inspector</span>
        </div>
        <div className="panel-content" style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ color: "var(--text-muted)", fontSize: "0.85rem", textAlign: "center" }}>
            No context snapshots received. Awaiting server synchronization.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="panel context-panel panel-last">
      <div className="panel-header">
        <span className="panel-title">Context Inspector</span>
        <span className="cockpit-brand-badge" style={{ textTransform: "none", fontSize: "0.68rem" }}>
          ID: {activeContextId}
        </span>
      </div>
      <div className="panel-content">
        {/* Scrubber slider for snapshots history */}
        {history.length > 1 && (
          <div className="context-history-scrubber-container">
            <div className="scrubber-header">
              <span>Snapshot Version Scrubber</span>
              <span>
                {index + 1} of {history.length}
              </span>
            </div>
            <input
              type="range"
              className="scrubber-slider"
              min="0"
              max={history.length - 1}
              value={index}
              onChange={(e) => setSelectedIndex(activeContextId, Number(e.target.value))}
            />
          </div>
        )}

        <div className="diff-tree">
          <TreeNode node={diffNode} defaultExpanded={true} />
        </div>
      </div>
    </div>
  );
};
