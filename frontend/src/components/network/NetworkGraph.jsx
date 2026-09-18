import React from "react";
import cytoscape from "cytoscape";
import { useTheme } from "../../context/ThemeContext";
import { getEntityTypeConfig } from "./entityTypes";

function createDoodleOverlay(container, nodes) {
  const layer = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  layer.setAttribute("class", "network-doodle-layer");
  layer.setAttribute("aria-hidden", "true");

  const doodles = new Map();
  nodes.forEach((node) => {
    const entityConfig = getEntityTypeConfig(node.type);
    const icon = entityConfig.icon;
    if (!icon) {
      return;
    }

    const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
    const iconSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    iconSvg.setAttribute("x", "-15");
    iconSvg.setAttribute("y", "-15");
    iconSvg.setAttribute("width", "30");
    iconSvg.setAttribute("height", "30");
    iconSvg.setAttribute("viewBox", "0 0 32 32");
    iconSvg.setAttribute("fill", "none");
    iconSvg.setAttribute("stroke", "#000000");
    iconSvg.setAttribute("stroke-width", "2.4");
    iconSvg.setAttribute("stroke-linecap", "round");
    iconSvg.setAttribute("stroke-linejoin", "round");
    iconSvg.innerHTML = icon;
    group.appendChild(iconSvg);
    layer.appendChild(group);
    doodles.set(node.id, group);
  });

  container.appendChild(layer);

  return {
    update(cy) {
      doodles.forEach((group, nodeId) => {
        const node = cy.$id(nodeId);
        if (node.empty()) {
          group.setAttribute("display", "none");
          return;
        }

        const position = node.renderedPosition();
        group.setAttribute("display", "block");
        group.setAttribute("transform", `translate(${position.x} ${position.y})`);
        group.setAttribute("class", [
          "network-doodle",
          node.hasClass("search-dim") ? "is-dimmed" : "",
          node.hasClass("search-related") ? "is-related" : "",
          node.hasClass("search-focus") || node.hasClass("search-target") || node.selected() ? "is-prominent" : "",
        ].filter(Boolean).join(" "));
      });
    },
    destroy() {
      layer.remove();
      doodles.clear();
    },
  };
}

const DEFAULT_ZOOM = 1;
const GRAPH_PADDING = 64;
const EMPTY_FLAGGED_NODE_IDS = [];
const EMPTY_ALERT_SEVERITY = {};
const ALERT_SEVERITY_CLASS = { HIGH: "node-alert-high", MEDIUM: "node-alert-medium", LOW: "node-alert-low" };
const ALL_ALERT_CLASSES = "node-alert-high node-alert-medium node-alert-low";

const RELATIONSHIP_LABELS = {
  ASSOCIATED_WITH: "Associated",
  FINANCIAL_TRANSACTION: "Financial",
  SEEN_AT: "Seen at",
  CALL: "Call",
  USES: "Uses",
  OWNS: "Owns",
  CONTACT_NUMBER: "Phone contact",
  RESIDES_AT: "Resides at",
  INVOLVES_AMOUNT: "Financial amount",
  CONTACT_EMAIL: "Email contact",
  IDENTIFIED_BY: "Identified by",
  USED_WEAPON: "Used weapon",
  AFFILIATED_WITH: "Affiliated with",
  POSSESSES_DRUG: "Possesses",
  PREDICTED: "Possible link (AI)",
};

function getRelationshipLabel(type) {
  return RELATIONSHIP_LABELS[type] || type.replaceAll("_", " ").toLowerCase();
}

function updateGraphTheme(cy, graphTheme) {
  cy.style()
    .selector("core")
    .style("background-color", graphTheme.canvas)
    .selector("node")
    .style({ color: graphTheme.label, "text-background-color": graphTheme.textBackground })
    .selector("edge")
    .style({ color: graphTheme.edgeLabel, "line-color": graphTheme.edge, "target-arrow-color": graphTheme.edge, "text-background-color": graphTheme.edgeTextBackground })
    .selector("node:selected")
    .style("border-color", graphTheme.selected)
    .selector("edge:selected")
    .style({ "line-color": graphTheme.selected, "target-arrow-color": graphTheme.selected })
    .selector(".search-focus")
    .style({ "border-color": graphTheme.focus, "overlay-color": graphTheme.focus })
    .selector(".search-edge-focus")
    .style({ "line-color": graphTheme.selected, "target-arrow-color": graphTheme.selected })
    .selector(".node-alert-high")
    .style({ "border-color": graphTheme.severity.HIGH, "shadow-color": graphTheme.severity.HIGH, "overlay-color": graphTheme.severityOverlay.HIGH })
    .selector(".node-alert-medium")
    .style({ "border-color": graphTheme.severity.MEDIUM, "shadow-color": graphTheme.severity.MEDIUM, "overlay-color": graphTheme.severityOverlay.MEDIUM })
    .selector(".node-alert-low")
    .style({ "border-color": graphTheme.severity.LOW, "shadow-color": graphTheme.severity.LOW, "overlay-color": graphTheme.severityOverlay.LOW })
    // IMPORTANT: the generic ".selector('edge')" call above re-asserts
    // line-color/target-arrow-color for every edge, and because this whole
    // chain runs in a *separate* effect after the graph is first built, that
    // generic edge re-assert lands after (and silently wins over) any other
    // edge color rule from the original stylesheet -- the bug that once made
    // predicted edges render in the plain theme color instead of purple
    // (their dashing still showed, since this function never touches
    // line-style). .edge-important/.edge-flagged now intentionally use this
    // same plain graphTheme.edge color (reverted on request), so only
    // .edge-predicted still needs to be re-asserted here to keep its color.
    .selector(".edge-predicted")
    .style({ "line-color": "#a855f7", "target-arrow-color": "#a855f7" })
    .update();
}

export default function NetworkGraph({
  nodes,
  edges,
  alertSeverityByNode = EMPTY_ALERT_SEVERITY,
  selectedNodeId,
  selectedEdgeId,
  searchNodeId,
  searchNodeIds = EMPTY_FLAGGED_NODE_IDS,
  searchEdgeIds = EMPTY_FLAGGED_NODE_IDS,
  searchTargetNodeId,
  onNodeSelect,
  onEdgeSelect,
  onReady,
  onZoomChange,
}) {
  const { isDark } = useTheme();
  const containerRef = React.useRef(null);
  const cyRef = React.useRef(null);
  const doodleSyncRef = React.useRef(null);
  const callbacksRef = React.useRef({ onNodeSelect, onEdgeSelect, onReady, onZoomChange });

  callbacksRef.current = { onNodeSelect, onEdgeSelect, onReady, onZoomChange };

  const graphTheme = React.useMemo(() => (isDark
    ? {
      canvas: "#0b1120",
      label: "#ecfeff",
      edgeLabel: "#a8bdc9",
      edge: "#426477",
      textBackground: "#111827",
      edgeTextBackground: "#111827",
      selected: "#f8fafc",
      focus: "#ffffff",
      // Matches this app's own --danger / --warning / --success tokens (dark theme)
      // so a node's risk color always agrees with its alert badge elsewhere in the UI.
      severity: { HIGH: "#f87171", MEDIUM: "#f59e0b", LOW: "#10b981" },
      severityOverlay: { HIGH: "#f87171", MEDIUM: "#f59e0b", LOW: "#10b981" },
    }
    : {
      canvas: "#f8fafc",
      label: "#173746",
      edgeLabel: "#486674",
      edge: "#8caab5",
      textBackground: "#ffffff",
      edgeTextBackground: "#ffffff",
      selected: "#173746",
      focus: "#087f9c",
      // Matches this app's own --danger / --warning / --success tokens (light theme)
      severity: { HIGH: "#dc2626", MEDIUM: "#d97706", LOW: "#10b981" },
      severityOverlay: { HIGH: "#dc2626", MEDIUM: "#d97706", LOW: "#10b981" },
    }), [isDark]);

  React.useEffect(() => {
    if (!containerRef.current || !nodes.length) {
      return undefined;
    }

    const cy = cytoscape({
      container: containerRef.current,
      elements: [
        ...nodes.map((node) => ({ data: node })),
        ...edges.map((edge) => ({
          data: { ...edge, displayLabel: getRelationshipLabel(edge.type) },
        })),
      ],
      style: [
        {
          selector: "core",
          style: {
            "background-color": graphTheme.canvas,
          },
        },
        {
          selector: "node",
          style: {
            // Show the full native label (Hindi labels render correctly once
            // "text-overflow-wrap" is not set to "anywhere" -- that setting was
            // letting Cytoscape's canvas renderer break lines in the middle of
            // a Devanagari consonant+vowel-sign cluster, which is what produced
            // the broken/dotted-circle glyphs. A short Latin gloss is appended
            // in parentheses when the node data provides one (data.graphLabel)
            // for readability, but the native script stays primary everywhere.
            label: (ele) => {
              const native = ele.data("label");
              const gloss = ele.data("graphLabel");
              return gloss ? `${native} (${gloss})` : native;
            },
            "text-valign": "bottom",
            "text-halign": "center",
            "text-margin-y": 11,
            "font-family": '"Nirmala UI", "Noto Sans Devanagari", "Mangal", "Segoe UI", Arial, Helvetica, sans-serif',
            "font-size": 10,
            "font-weight": 600,
            color: graphTheme.label,
            width: "mapData(centrality, 0, 1, 34, 50)",
            height: "mapData(centrality, 0, 1, 34, 50)",
            shape: (ele) => getEntityTypeConfig(ele.data("type")).shape,
            "background-color": (ele) => getEntityTypeConfig(ele.data("type")).color,
            "background-opacity": 0.86,
            "border-width": 2,
            "border-color": (ele) => getEntityTypeConfig(ele.data("type")).color,
            "shadow-blur": 12,
            "shadow-color": (ele) => getEntityTypeConfig(ele.data("type")).color,
            "shadow-opacity": 0.32,
            "text-wrap": "wrap",
            "text-max-width": 170,
            "text-overflow-wrap": "whitespace",
            "text-background-color": graphTheme.textBackground,
            "text-background-opacity": 0.9,
            "text-background-padding": 3,
            "text-background-shape": "roundrectangle",
          },
        },
        {
          selector: "edge",
          style: {
            width: (ele) => (ele.hasClass("edge-predicted") ? 2.4 : ele.hasClass("edge-flagged") ? 2.6 : ele.hasClass("edge-important") ? 2 : 1.4),
            label: "data(displayLabel)",
            "font-family": '"Nirmala UI", "Noto Sans Devanagari", "Mangal", "Segoe UI", Arial, Helvetica, sans-serif',
            "font-size": 8,
            "font-weight": 600,
            color: graphTheme.edgeLabel,
            "curve-style": "bezier",
            "target-arrow-shape": "triangle",
            "line-color": graphTheme.edge,
            "target-arrow-color": graphTheme.edge,
            "arrow-scale": 0.8,
            "text-rotation": "autorotate",
            "text-background-color": graphTheme.edgeTextBackground,
            "text-background-opacity": 1,
            "text-background-shape": "roundrectangle",
            "text-background-padding": 3,
            "line-style": "solid",
          },
        },
        {
          // A node with one or more investigative alerts against it. Color
          // escalates with the alert's severity (green -> amber -> red),
          // matching the same severity colors used on the Alerts page, and
          // the node is drawn above its neighbors so the highlight is never
          // hidden behind an overlapping edge or node.
          selector: ".node-alert-high, .node-alert-medium, .node-alert-low",
          style: {
            "border-width": 4.5,
            "shadow-blur": 28,
            "shadow-opacity": 0.9,
            "overlay-opacity": 0.2,
            "overlay-padding": 10,
            "z-index": 20,
          },
        },
        {
          selector: ".node-alert-high",
          style: {
            "border-color": graphTheme.severity.HIGH,
            "shadow-color": graphTheme.severity.HIGH,
            "overlay-color": graphTheme.severityOverlay.HIGH,
          },
        },
        {
          selector: ".node-alert-medium",
          style: {
            "border-color": graphTheme.severity.MEDIUM,
            "shadow-color": graphTheme.severity.MEDIUM,
            "overlay-color": graphTheme.severityOverlay.MEDIUM,
          },
        },
        {
          selector: ".node-alert-low",
          style: {
            "border-color": graphTheme.severity.LOW,
            "shadow-color": graphTheme.severity.LOW,
            "overlay-color": graphTheme.severityOverlay.LOW,
          },
        },
        {
          // Confirmed, direct relationship -- same plain line color as any
          // other direct edge (kept back to the original, uniform color on
          // request: only AI-predicted edges below get a distinct color now).
          // Width/opacity/z-index still mark it as higher-confidence, just
          // not by hue.
          selector: ".edge-important",
          style: {
            "line-color": graphTheme.edge,
            "target-arrow-color": graphTheme.edge,
            "line-opacity": 0.86,
          },
        },
        {
          // Confirmed relationship that touches an alerted entity -- still a
          // solid, real link (never dashed: dashing is reserved exclusively
          // for AI-predicted/unconfirmed edges below). Color reverted to the
          // original plain edge color on request; still drawn a bit bolder
          // via width/z-index so it's not entirely lost among plain edges.
          selector: ".edge-flagged",
          style: {
            "line-color": graphTheme.edge,
            "target-arrow-color": graphTheme.edge,
            "line-style": "solid",
            "line-opacity": 0.96,
            "z-index": 12,
          },
        },
        {
          // AI-predicted (unconfirmed) link -- the ONLY dashed edge in the
          // whole graph, so "dashed" always and unambiguously means "AI
          // candidate, not a confirmed relationship." Every confirmed edge
          // (plain, important, or flagged) is solid.
          selector: ".edge-predicted",
          style: {
            "line-color": "#a855f7",
            "target-arrow-color": "#a855f7",
            "target-arrow-shape": "triangle-backcurve",
            "arrow-scale": 0.9,
            "line-style": "dashed",
            "line-dash-pattern": [7, 4],
            width: 2.4,
            "line-opacity": 0.95,
            "font-style": "italic",
            "font-weight": 700,
            "text-background-opacity": 1,
            "z-index": 16,
          },
        },
        {
          selector: "node:selected",
          style: {
            "border-width": 4,
            "border-color": graphTheme.selected,
            "overlay-color": "#67e8f9",
            "overlay-opacity": 0.16,
            "overlay-padding": 8,
          },
        },
        {
          selector: "edge:selected",
          style: {
            width: 3,
            "line-color": graphTheme.selected,
            "target-arrow-color": graphTheme.selected,
          },
        },
        {
          selector: ".search-dim",
          style: {
            opacity: 0.16,
            "text-opacity": 0.2,
          },
        },
        {
          selector: ".search-related",
          style: {
            opacity: 0.9,
            "text-opacity": 1,
          },
        },
        {
          selector: ".search-focus",
          style: {
            opacity: 1,
            "text-opacity": 1,
            "border-width": 5,
            "border-color": graphTheme.focus,
            "overlay-color": graphTheme.focus,
            "overlay-opacity": 0.12,
            "overlay-padding": 8,
          },
        },
        {
          selector: ".search-target",
          style: {
            opacity: 1,
            width: 62,
            height: 62,
            "border-width": 6,
            "border-color": graphTheme.focus,
            "shadow-color": "#67e8f9",
            "shadow-blur": 24,
            "shadow-opacity": 0.95,
          },
        },
        {
          selector: ".search-neighbor",
          style: {
            opacity: 1,
            "border-width": 3,
            "border-color": "#67e8f9",
            "shadow-color": "#67e8f9",
            "shadow-blur": 14,
            "shadow-opacity": 0.6,
          },
        },
        {
          selector: ".search-edge-focus",
          style: {
            opacity: 1,
            width: 5,
            "line-color": graphTheme.selected,
            "target-arrow-color": graphTheme.selected,
            "shadow-color": "#67e8f9",
            "shadow-blur": 12,
            "shadow-opacity": 0.8,
          },
        },
      ],
      layout: {
        name: "breadthfirst",
        directed: false,
        circle: false,
        animate: false,
        avoidOverlap: true,
        nodeDimensionsIncludeLabels: true,
        spacingFactor: 1.35,
        padding: GRAPH_PADDING,
      },
      zoom: DEFAULT_ZOOM,
      pan: { x: 0, y: 0 },
      minZoom: 0.2,
      maxZoom: 2.4,
    });

    cy.on("tap", "node", (event) => {
      const node = event.target;
      const nodeData = node.data();
      callbacksRef.current.onNodeSelect?.(nodeData);
    });

    cy.on("tap", "edge", (event) => {
      const edge = event.target;
      callbacksRef.current.onEdgeSelect?.(edge.data());
    });

    cy.on("tap", (event) => {
      if (event.target === cy) {
        callbacksRef.current.onNodeSelect?.(null);
        callbacksRef.current.onEdgeSelect?.(null);
      }
    });

    cy.on("zoom", () => {
      callbacksRef.current.onZoomChange?.(cy.zoom());
    });

    const doodles = createDoodleOverlay(containerRef.current, nodes);
    let animationFrame;
    const syncDoodles = () => {
      if (animationFrame) {
        return;
      }
      animationFrame = window.requestAnimationFrame(() => {
        animationFrame = undefined;
        doodles.update(cy);
      });
    };

    doodleSyncRef.current = syncDoodles;
    cy.on("pan zoom render resize layoutstop", syncDoodles);
    cy.on("position", "node", syncDoodles);

    cyRef.current = cy;
    nodes.forEach((node) => {
      const severityClass = ALERT_SEVERITY_CLASS[alertSeverityByNode[node.id]];
      if (severityClass) {
        cy.$id(node.id).addClass(severityClass);
      }
    });
    edges.forEach((edge) => {
      const element = cy.$id(edge.id);
      if (edge.status === "predicted") {
        element.addClass("edge-predicted");
      } else if (alertSeverityByNode[edge.source] || alertSeverityByNode[edge.target]) {
        element.addClass("edge-flagged");
      } else if (Number(edge.confidence) >= 0.9) {
        element.addClass("edge-important");
      }
    });
    callbacksRef.current.onReady?.(cy);
    cy.fit(cy.elements(), GRAPH_PADDING);
    syncDoodles();

    const resizeObserver = new ResizeObserver(() => {
      cy.resize();
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      if (animationFrame) {
        window.cancelAnimationFrame(animationFrame);
      }
      doodleSyncRef.current = null;
      doodles.destroy();
      resizeObserver.disconnect();
      cy.destroy();
      cyRef.current = null;
    };
  }, [nodes, edges]);

  React.useEffect(() => {
    if (!cyRef.current) {
      return;
    }

    updateGraphTheme(cyRef.current, graphTheme);
    doodleSyncRef.current?.();
  }, [graphTheme]);

  React.useEffect(() => {
    if (!cyRef.current) {
      return;
    }

    const cy = cyRef.current;
    cy.nodes().removeClass(ALL_ALERT_CLASSES);
    cy.edges().removeClass("edge-flagged edge-important edge-predicted");
    nodes.forEach((node) => {
      const severityClass = ALERT_SEVERITY_CLASS[alertSeverityByNode[node.id]];
      if (severityClass) {
        cy.$id(node.id).addClass(severityClass);
      }
    });
    edges.forEach((edge) => {
      const element = cy.$id(edge.id);
      if (edge.status === "predicted") {
        element.addClass("edge-predicted");
      } else if (alertSeverityByNode[edge.source] || alertSeverityByNode[edge.target]) {
        element.addClass("edge-flagged");
      } else if (Number(edge.confidence) >= 0.9) {
        element.addClass("edge-important");
      }
    });
    doodleSyncRef.current?.();
  }, [nodes, edges, alertSeverityByNode]);

  React.useEffect(() => {
    if (!cyRef.current) {
      return;
    }

    if (selectedNodeId) {
      cyRef.current.elements().unselect();
      cyRef.current.$(`#${selectedNodeId}`).select();
    } else {
      cyRef.current.elements().unselect();
    }
    doodleSyncRef.current?.();
  }, [selectedNodeId]);

  React.useEffect(() => {
    if (!cyRef.current) {
      return;
    }

    if (selectedEdgeId) {
      cyRef.current.$(`#${selectedEdgeId}`).select();
    } else {
      cyRef.current.edges().unselect();
    }
    doodleSyncRef.current?.();
  }, [selectedEdgeId]);

  React.useEffect(() => {
    if (!cyRef.current) {
      return;
    }

    const cy = cyRef.current;
    cy.elements().removeClass("search-dim search-related search-focus search-target search-neighbor");
    cy.elements().removeClass("search-edge-focus");

    const highlightedNodeIds = new Set(searchNodeIds);
    const highlightedEdgeIds = new Set(searchEdgeIds);
    if (!searchNodeId && highlightedNodeIds.size === 0 && highlightedEdgeIds.size === 0) {
      doodleSyncRef.current?.();
      return;
    }

    cy.elements().addClass("search-dim");
    const focusedNodes = searchNodeIds.length
      ? cy.nodes().filter((node) => highlightedNodeIds.has(node.id()))
      : cy.$id(searchNodeId);
    const focusedEdges = cy.edges().filter((edge) => highlightedEdgeIds.has(edge.id()));
    const focusElements = focusedNodes.union(focusedEdges);

    if (focusElements.empty()) {
      doodleSyncRef.current?.();
      return;
    }

    focusedNodes.removeClass("search-dim").addClass("search-focus");
    if (searchTargetNodeId) {
      focusedNodes.filter((node) => node.id() === searchTargetNodeId).removeClass("search-focus").addClass("search-target");
      focusedNodes.filter((node) => node.id() !== searchTargetNodeId).addClass("search-neighbor");
    }
    focusedEdges.removeClass("search-dim").addClass("search-edge-focus");
    if (searchNodeIds.length === 0 && searchEdgeIds.length === 0) {
      focusedNodes.connectedEdges().removeClass("search-dim").addClass("search-related");
      focusedNodes.neighborhood("node").removeClass("search-dim").addClass("search-related");
    }
    doodleSyncRef.current?.();
  }, [searchNodeId, searchNodeIds, searchEdgeIds, searchTargetNodeId]);

  return <div ref={containerRef} className="network-graph" />;
}
