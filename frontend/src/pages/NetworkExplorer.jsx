import React from "react";
import AppLayout from "../components/layout/AppLayout";
import NetworkGraph from "../components/network/NetworkGraph";
import NetworkToolbar from "../components/network/NetworkToolbar";
import NetworkLegend from "../components/network/NetworkLegend";
import EntityInvestigationPanel from "../components/network/EntityInvestigationPanel";
import RelationshipPanel from "../components/network/RelationshipPanel";
import SearchResults from "../components/network/SearchResults";
import SearchHistory from "../components/network/SearchHistory";
import InvestigationSummary from "../components/network/InvestigationSummary";
import useCase from "../hooks/useCase";
import { fetchAlerts, fetchCaseDetail, fetchEntities, fetchNetwork, askAssistant, fetchEvidence } from "../services/api";

const ZOOM_STEP = 0.2;
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 2.4;

function buildRelatedEntities(node, edges, allNodes) {
  if (!node) {
    return [];
  }

  const relatedIds = new Set();

  edges.forEach((edge) => {
    if (edge.source === node.id) {
      relatedIds.add(edge.target);
    }
    if (edge.target === node.id) {
      relatedIds.add(edge.source);
    }
  });

  const related = allNodes.filter((candidate) => relatedIds.has(candidate.id));
  return related;
}

function getPhoneNumber(phoneNode) {
  const value = phoneNode?.phone_number || phoneNode?.phoneNumber || phoneNode?.name || phoneNode?.label;
  return typeof value === "string" && /^\+?[\d\s()-]{7,}$/.test(value.trim()) ? value.trim() : null;
}

export default function NetworkExplorer() {
  const { caseId, cases: caseOptions, setCaseId } = useCase();
  const [nodes, setNodes] = React.useState([]);
  const [edges, setEdges] = React.useState([]);
  const [alerts, setAlerts] = React.useState([]);
  const [entityIndex, setEntityIndex] = React.useState({});
  const [loading, setLoading] = React.useState(Boolean(caseId));
  const [error, setError] = React.useState("");
  const [searchTerm, setSearchTerm] = React.useState("");
  const [searchNodeId, setSearchNodeId] = React.useState(null);
  const [searchMessage, setSearchMessage] = React.useState("");
  const [semanticResult, setSemanticResult] = React.useState(null);
  const [semanticLoading, setSemanticLoading] = React.useState(false);
  const [selectedNode, setSelectedNode] = React.useState(null);
  const [selectedEdge, setSelectedEdge] = React.useState(null);
  const [graphCy, setGraphCy] = React.useState(null);
  const [currentZoom, setCurrentZoom] = React.useState(1);
  const [caseItem, setCaseItem] = React.useState(null);
  const [searchHistory, setSearchHistory] = React.useState([]);
  const [evidenceRecords, setEvidenceRecords] = React.useState([]);
  const [evidenceLoading, setEvidenceLoading] = React.useState(false);
  const [isHighCentralityPopoverOpen, setHighCentralityPopoverOpen] = React.useState(false);
  const highCentralityRef = React.useRef(null);
  // Default to on: an investigator opening a case should see the AI's
  // candidate leads immediately, not only after finding the toggle.
  const [showPredicted, setShowPredicted] = React.useState(true);

  const hasMeaningfulSemanticResult = React.useCallback((result) => {
    if (!result || result.isSemanticResult === false) {
      return false;
    }

    if (result.status !== "SUCCESS") {
      return false;
    }

    const entityItems = Array.isArray(result.entities) ? result.entities.filter((entity) => entity && (entity.id || entity.name || entity.label)) : [];
    const connectedItems = Array.isArray(result.connected_entities) ? result.connected_entities.filter((entity) => entity && (entity.id || entity.name || entity.label)) : [];
    const relationshipItems = Array.isArray(result.relationships) ? result.relationships.filter((relationship) => relationship && (relationship.id || relationship.source || relationship.target)) : [];
    const searchItems = Array.isArray(result.results) ? result.results.filter((item) => item && (item.entity_id || item.entity_name || item.relationship_id || item.connected_entity_id)) : [];

    return entityItems.length > 0 || connectedItems.length > 0 || relationshipItems.length > 0 || searchItems.length > 0;
  }, []);

  React.useEffect(() => {
    let ignore = false;

    async function loadNetwork() {
      setLoading(Boolean(caseId));
      setError("");
      setNodes([]);
      setEdges([]);
      setAlerts([]);
      setEntityIndex({});
      setCaseItem(null);
      setGraphCy(null);
      setSelectedNode(null);
      setSelectedEdge(null);
      setSearchTerm("");
      setSearchNodeId(null);
      setSearchMessage("");
      setSemanticResult(null);
      setSemanticLoading(false);
      setSearchHistory([]);
      setEvidenceRecords([]);
      setEvidenceLoading(false);

      try {
        let networkData = { nodes: [], edges: [] };
        let alertsData = [];
        let entitiesData = [];
        let detail = null;

        if (caseId) {
          [networkData, alertsData, entitiesData, detail] = await Promise.all([
            fetchNetwork(caseId),
            fetchAlerts(caseId),
            fetchEntities(caseId),
            fetchCaseDetail(caseId),
          ]);
        }

        if (!ignore) {
          setNodes(networkData.nodes || []);
          setEdges(networkData.edges || []);
          setAlerts(alertsData || []);
          setCaseItem(detail);
          setEntityIndex(
            (entitiesData || []).reduce((accumulator, entity) => {
              accumulator[entity.id] = entity;
              return accumulator;
            }, {}),
          );

          const traceContext = window.sessionStorage.getItem("trace-evidence-context");
          if (traceContext) {
            const tracePayload = JSON.parse(traceContext);
            if (tracePayload?.caseId === caseId) {
              const highlightedNodeIds = Array.isArray(tracePayload.nodeIds) ? tracePayload.nodeIds : [];
              const highlightedEdgeIds = Array.isArray(tracePayload.edgeIds) ? tracePayload.edgeIds : [];
              setSemanticResult({
                highlightedNodeIds,
                highlightedEdgeIds,
                searchTargetNodeId: highlightedNodeIds[0] || null,
                message: "Evidence trace highlights the related entities and relationships.",
                status: "SUCCESS",
                entities: highlightedNodeIds.map((nodeId) => ({ id: nodeId, name: nodeId })),
                relationships: highlightedEdgeIds.map((edgeId) => ({ id: edgeId })),
                isSemanticResult: false,
              });
              setSelectedNode(networkData.nodes.find((node) => node.id === highlightedNodeIds[0]) || null);
              setSelectedEdge(networkData.edges.find((edge) => edge.id === highlightedEdgeIds[0]) || null);
              setSearchMessage("Evidence trace loaded.");
            }
          }
        }
      } catch (loadError) {
        if (!ignore) {
          setError(loadError.message || "Failed to load network data.");
        }
      } finally {
        if (!ignore) {
          setLoading(false);
        }
      }
    }

    loadNetwork();

    return () => {
      ignore = true;
    };
  }, [caseId]);

  const focusNode = React.useCallback(
    (match) => {
      if (!graphCy || !match) {
        return;
      }

      const element = graphCy.$id(match.id);
      if (!element || element.length === 0) {
        return;
      }

      setSelectedNode(match);
      setSelectedEdge(null);
      setSearchNodeId(match.id);
      setSearchMessage("");
      graphCy.center(element);
      graphCy.animate({ center: { eles: element }, zoom: 1.3 }, { duration: 200 });
      element.select();
    },
    [graphCy],
  );

  const handleSearchSubmit = (event) => {
    event.preventDefault();

    const trimmed = searchTerm.trim();
    if (!trimmed) {
      return;
    }

    const match = nodes.find(
      (node) =>
        node.id.toLowerCase() === trimmed.toLowerCase() ||
        node.label?.toLowerCase().includes(trimmed.toLowerCase()) ||
        node.type?.toLowerCase().includes(trimmed.toLowerCase()),
    );

    if (match) {
      setSemanticResult(null);
      focusNode(match);
      return;
    }

    if (!caseId) {
      setSearchNodeId(null);
      setSearchMessage("Select a case before analyzing a natural-language query.");
      return;
    }

    setSemanticLoading(true);
    setSearchMessage("");
    setSemanticResult(null);
    askAssistant(trimmed, caseId)
      .then((result) => {
        setSearchHistory((current) => [{ id: `${Date.now()}-${trimmed}`, query: trimmed, intent: result.intent?.type || result.intent, result }, ...current.filter((entry) => entry.query !== trimmed)].slice(0, 8));
        setEvidenceRecords(result.evidence || []);
        const intentType = result.intent?.type || result.intent;
        const nextSemanticResult = hasMeaningfulSemanticResult(result) ? { ...result, isSemanticResult: true } : null;
        setSemanticResult(nextSemanticResult);
        setSearchNodeId(null);
        const graphAction = result.graph_action || {};
        const relationshipIds = graphAction.relationship_ids || (result.relationships || []).map((relationship) => relationship.id);
        const targetNodeId = graphAction.target_entity_id || result.entities?.[0]?.id || null;
        const resultNodeIds = new Set(
          graphAction.node_ids || graphAction.entity_ids || (result.entities || []).map((entity) => entity.id),
        );
        if (!graphAction.node_ids && !graphAction.entity_ids) {
          (result.connected_entities || []).forEach((entity) => resultNodeIds.add(entity.id));
          (result.relationships || []).forEach((relationship) => {
            resultNodeIds.add(relationship.source);
            resultNodeIds.add(relationship.target);
          });
        }
        if (result.status !== "SUCCESS" || (!result.entities?.length && !result.relationships?.length)) {
          setSearchMessage(result.message || "No relevant entities or relationships found.");
          return;
        }
        const firstRelationship = result.relationships?.[0];
        if ((intentType === "ENTITY_INFORMATION" || intentType === "NEIGHBOR_QUERY" || intentType === "RISK_QUERY" || intentType === "TWO_HOP_QUERY") && targetNodeId) {
          const targetNode = nodes.find((node) => node.id === targetNodeId);
          setSelectedNode(targetNode || null);
          setSelectedEdge(null);
        } else if (firstRelationship) {
          setSelectedEdge(edges.find((edge) => edge.id === firstRelationship.id) || firstRelationship);
          setSelectedNode(null);
        } else if (result.entities?.[0]) {
          const resultNode = nodes.find((node) => node.id === result.entities[0].id);
          if (resultNode) {
            setSelectedNode(resultNode);
            setSelectedEdge(null);
          }
        }
        const resultCount = intentType === "ENTITY_INFORMATION" || intentType === "NEIGHBOR_QUERY" || intentType === "RISK_QUERY" || intentType === "TWO_HOP_QUERY"
          ? result.connected_entities?.length || 0
          : result.relationships?.length || result.entities?.length || 0;
        setSearchMessage(`${resultCount} direct network connection${resultCount === 1 ? "" : "s"} found.`);
        setSemanticResult({
          ...result,
          highlightedNodeIds: [...resultNodeIds],
          highlightedEdgeIds: relationshipIds,
          searchTargetNodeId: targetNodeId,
          isSemanticResult: hasMeaningfulSemanticResult(result),
        });
      })
      .catch((searchError) => {
        setSemanticResult(null);
        setSearchMessage("Search service unavailable");
      })
      .finally(() => setSemanticLoading(false));
  };

  const restoreSearch = (entry) => {
    setSearchTerm(entry.query);
    const result = entry.result;
    const graphAction = result.graph_action || {};
    const nodeIds = graphAction.node_ids || graphAction.entity_ids || (result.entities || []).map((entity) => entity.id);
    const edgeIds = graphAction.relationship_ids || (result.relationships || []).map((relationship) => relationship.id);
    const targetId = graphAction.target_entity_id || result.entities?.[0]?.id || null;
    const restoredResult = hasMeaningfulSemanticResult(result) ? { ...result, highlightedNodeIds: nodeIds, highlightedEdgeIds: edgeIds, searchTargetNodeId: targetId, isSemanticResult: true } : null;
    setSemanticResult(restoredResult);
    setEvidenceRecords(result.evidence || []);
    setSearchMessage(result.message || "Restored previous investigation.");
    if (targetId) {
      setSelectedNode(nodes.find((node) => node.id === targetId) || null);
      setSelectedEdge(null);
    }
  };

  const handleSearchChange = (value) => {
    setSearchTerm(value);
    setSearchMessage("");
    if (!value.trim()) {
      setSemanticResult(null);
    }
  };

  const handleSuggestionSelect = (match) => {
    setSearchTerm(match.label);
    focusNode(match);
  };

  const handleClearSearch = () => {
    setSearchTerm("");
    setSearchNodeId(null);
    setSearchMessage("");
    setSemanticResult(null);
  };

  const focusResultInGraph = React.useCallback(
    (target) => {
      if (!graphCy) {
        return;
      }

      const nodeId = target?.entity_id || target?.source || target?.connected_entity_id || null;
      const edgeId = target?.relationship_id || null;

      if (edgeId) {
        const edge = edges.find((candidate) => candidate.id === edgeId);
        const edgeElement = graphCy.$id(edgeId);
        if (edge && edgeElement && !edgeElement.empty()) {
          const connectedNodes = [graphCy.$id(edge.source), graphCy.$id(edge.target)];
          const centerNodes = connectedNodes.filter((entry) => entry && !entry.empty());
          setSelectedEdge(edge);
          setSelectedNode(null);
          setSearchMessage("Focused on relevant relationship.");
          setSemanticResult((current) => ({
            ...(current || {}),
            highlightedNodeIds: [edge.source, edge.target],
            highlightedEdgeIds: [edge.id],
            searchTargetNodeId: edge.source,
            status: "SUCCESS",
            isSemanticResult: false,
          }));
          if (centerNodes.length) {
            graphCy.center(centerNodes);
            graphCy.animate({ center: { eles: centerNodes }, zoom: 1.2 }, { duration: 180 });
          }
          return;
        }
      }

      if (nodeId) {
        const node = nodes.find((candidate) => candidate.id === nodeId) || null;
        if (node) {
          setSelectedNode(node);
          setSelectedEdge(null);
          setSearchNodeId(node.id);
          setSemanticResult((current) => ({
            ...(current || {}),
            highlightedNodeIds: [node.id],
            highlightedEdgeIds: [],
            searchTargetNodeId: node.id,
            status: "SUCCESS",
            isSemanticResult: false,
          }));
          const element = graphCy.$id(node.id);
          if (!element.empty()) {
            graphCy.center(element);
            graphCy.animate({ center: { eles: element }, zoom: 1.2 }, { duration: 180 });
          }
        }
      }
    },
    [edges, graphCy, nodes],
  );

  const searchSuggestions = React.useMemo(() => {
    const trimmed = searchTerm.trim().toLowerCase();
    if (!trimmed) {
      return [];
    }

    return nodes
      .filter((node) =>
        [node.id, node.label, node.type].some((value) => value?.toLowerCase().includes(trimmed)),
      )
      .slice(0, 5);
  }, [nodes, searchTerm]);

  const handleFitGraph = () => {
    if (!graphCy) {
      return;
    }

    graphCy.fit();
  };

  const handleZoomIn = () => {
    if (!graphCy) {
      return;
    }

    const level = Math.min(MAX_ZOOM, graphCy.zoom() + ZOOM_STEP);
    graphCy.zoom({
      level,
      renderedPosition: {
        x: graphCy.width() / 2,
        y: graphCy.height() / 2,
      },
    });
  };

  const handleZoomOut = () => {
    if (!graphCy) {
      return;
    }

    const level = Math.max(MIN_ZOOM, graphCy.zoom() - ZOOM_STEP);
    graphCy.zoom({
      level,
      renderedPosition: {
        x: graphCy.width() / 2,
        y: graphCy.height() / 2,
      },
    });
  };

  const handleResetView = () => {
    if (!graphCy) {
      return;
    }

    graphCy.reset();
    graphCy.fit();
    setSelectedNode(null);
    setSelectedEdge(null);
    setSearchNodeId(null);
    setSearchMessage("");
    setSemanticResult(null);
    setSearchTerm("");
    graphCy.elements().removeClass("search-dim search-related search-focus search-target search-neighbor search-edge-focus");
  };

  const handleCloseInvestigation = () => {
    setSelectedNode(null);
    setSelectedEdge(null);
    setSearchNodeId(null);
    setSearchMessage("");
    setSemanticResult(null);
    if (graphCy) {
      graphCy.elements().unselect();
      graphCy.elements().removeClass("search-dim search-related search-focus search-target search-neighbor search-edge-focus");
    }
  };

  const selectedEntity = React.useMemo(() => {
    if (!selectedNode) {
      return null;
    }

    const sourceEntity = entityIndex[selectedNode.id] || {};

    return {
      ...sourceEntity,
      id: selectedNode.id,
      label: selectedNode.label || sourceEntity.name || selectedNode.id,
      name: sourceEntity.name || selectedNode.label || selectedNode.id,
      type: selectedNode.type || sourceEntity.type || "UNKNOWN",
      confidence: selectedNode.confidence ?? sourceEntity.confidence ?? 0,
      community: selectedNode.community ?? sourceEntity.community ?? 0,
      centrality: selectedNode.centrality ?? sourceEntity.centrality ?? 0,
    };
  }, [entityIndex, selectedNode]);

  const relationshipRows = React.useMemo(() => {
    if (!selectedNode) {
      return [];
    }

    return edges
      .filter((edge) => edge.source === selectedNode.id || edge.target === selectedNode.id)
      .map((edge) => {
        const relatedEntityId = edge.source === selectedNode.id ? edge.target : edge.source;
        const relatedEntity = nodes.find((node) => node.id === relatedEntityId);

        return {
          id: edge.id,
          type: edge.type,
          relatedEntityId,
          relatedEntityLabel: relatedEntity?.label || relatedEntityId,
          confidence: edge.confidence,
          status: edge.status,
          evidenceText: edge.evidence_text,
        };
      });
  }, [edges, nodes, selectedNode]);

  const selectedAlert = React.useMemo(
    () => alerts.find((alert) => alert.entity_id === selectedNode?.id),
    [alerts, selectedNode],
  );

  const relatedEntities = React.useMemo(
    () => buildRelatedEntities(selectedNode, edges, nodes),
    [selectedNode, edges, nodes],
  );

  const selectedEdgeSource = React.useMemo(
    () => nodes.find((node) => node.id === selectedEdge?.source),
    [nodes, selectedEdge],
  );

  const selectedEdgeTarget = React.useMemo(
    () => nodes.find((node) => node.id === selectedEdge?.target),
    [nodes, selectedEdge],
  );

  const selectedCallPhone = React.useMemo(() => {
    if (selectedEdge?.type !== "CALL") {
      return null;
    }

    const callParticipants = new Set([selectedEdge.source, selectedEdge.target]);
    const phoneIds = new Set(
      edges
        .filter((edge) => edge.type === "USES" && callParticipants.has(edge.source))
        .map((edge) => edge.target),
    );

    return nodes.find((node) => node.type === "PHONE" && phoneIds.has(node.id)) || null;
  }, [edges, nodes, selectedEdge]);

  const selectedCallPhoneNumber = React.useMemo(
    () => getPhoneNumber(selectedCallPhone),
    [selectedCallPhone],
  );

  React.useEffect(() => {
    if (!caseId || (!selectedNode && !selectedEdge) || semanticResult?.evidence?.length) {
      return;
    }
    setEvidenceLoading(true);
    fetchEvidence(caseId, selectedNode?.id, selectedEdge?.id)
      .then((payload) => setEvidenceRecords(payload.records || []))
      .catch(() => setEvidenceRecords([]))
      .finally(() => setEvidenceLoading(false));
  }, [caseId, selectedNode, selectedEdge, semanticResult]);

  const handleTraceEvidence = (record) => {
    if (record.relationship_id) {
      const edge = edges.find((candidate) => candidate.id === record.relationship_id);
      if (!edge) return;
      setSelectedEdge(edge);
      setSelectedNode(null);
      setSemanticResult((current) => ({
        ...(current || {}),
        highlightedNodeIds: [edge.source, edge.target],
        highlightedEdgeIds: [edge.id],
        searchTargetNodeId: null,
        isSemanticResult: false,
      }));
    } else if (record.entity_id) {
      const node = nodes.find((candidate) => candidate.id === record.entity_id);
      if (node) focusNode(node);
    }
  };

  const handlePhoneSelect = (phoneNode) => {
    if (!graphCy || !phoneNode) {
      return;
    }

    const element = graphCy.$id(phoneNode.id);
    if (element.empty()) {
      return;
    }

    setSelectedNode(phoneNode);
    setSelectedEdge(null);
    setSearchNodeId(phoneNode.id);
    setSearchMessage("");
    graphCy.elements().unselect();
    element.select();
  };

  const highCentralityEntities = React.useMemo(
    () =>
      [...nodes]
        .filter((node) => Number(node.centrality) >= 0.6)
        .sort((a, b) => Number(b.centrality) - Number(a.centrality)),
    [nodes],
  );

  const highCentralityEntityDetails = React.useMemo(
    () =>
      highCentralityEntities.map((node) => {
        const connectedEntityIds = new Set();
        edges.forEach((edge) => {
          if (edge.source === node.id) {
            connectedEntityIds.add(edge.target);
          }
          if (edge.target === node.id) {
            connectedEntityIds.add(edge.source);
          }
        });

        return {
          ...node,
          connectedEntities: connectedEntityIds.size,
          directRelationships: edges.filter((edge) => edge.source === node.id || edge.target === node.id).length,
          communityId: node.community ?? null,
          centrality: Number(node.centrality ?? 0),
        };
      }),
    [edges, highCentralityEntities],
  );

  React.useEffect(() => {
    setHighCentralityPopoverOpen(false);
  }, [caseId]);

  React.useEffect(() => {
    if (!isHighCentralityPopoverOpen) {
      return undefined;
    }

    const handlePointerDown = (event) => {
      if (highCentralityRef.current && !highCentralityRef.current.contains(event.target)) {
        setHighCentralityPopoverOpen(false);
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [isHighCentralityPopoverOpen]);

  const entitySummary = React.useMemo(() => {
    const typeCounts = {};
    nodes.forEach((node) => {
      const type = node.type || "UNKNOWN";
      typeCounts[type] = (typeCounts[type] || 0) + 1;
    });
    return typeCounts;
  }, [nodes]);

  const graphEntityTypes = React.useMemo(
    () => Object.keys(entitySummary).sort((a, b) => entitySummary[b] - entitySummary[a]),
    [entitySummary],
  );

  const predictedCount = React.useMemo(() => edges.filter((edge) => edge.status === "predicted").length, [edges]);

  const crossCaseCount = React.useMemo(() => nodes.filter((node) => node.cross_case?.length).length, [nodes]);

  const selectedCrossCaseMatches = selectedNode?.cross_case || [];

  const handleSwitchCase = React.useCallback(
    (targetCaseId) => {
      if (targetCaseId && targetCaseId !== caseId) {
        setCaseId(targetCaseId);
      }
    },
    [caseId, setCaseId],
  );

  const SEVERITY_RANK = { LOW: 1, MEDIUM: 2, HIGH: 3 };
  const alertSeverityByNode = React.useMemo(() => {
    const map = {};
    alerts.forEach((alert) => {
      if (!alert.entity_id) {
        return;
      }
      const current = map[alert.entity_id];
      if (!current || (SEVERITY_RANK[alert.severity] || 0) > (SEVERITY_RANK[current] || 0)) {
        map[alert.entity_id] = alert.severity;
      }
    });
    return map;
  }, [alerts]);

  const visibleEdges = React.useMemo(
    () => (showPredicted ? edges : edges.filter((edge) => edge.status !== "predicted")),
    [edges, showPredicted],
  );

  let content;

  const selectedCaseTitle = caseItem?.title || caseOptions.find((item) => item.id === caseId)?.title;

  content = (
    <>
        <section className="network-case-context">
          <div>
            <div className="eyebrow">Relationship Graph Canvas</div>
            <h2>{selectedCaseTitle || "Select a case from the top bar"}</h2>
            {caseId && <p>{caseId}</p>}
          </div>
        </section>
        <section className="network-summary-grid">
          <div className="summary-card">
            <span className="summary-label">Nodes</span>
            <strong>{nodes.length}</strong>
          </div>
          <div className="summary-card">
            <span className="summary-label">Relationships</span>
            <strong>{edges.length}</strong>
          </div>
          <div
            ref={highCentralityRef}
            className={`summary-card summary-card-clickable ${isHighCentralityPopoverOpen ? "is-open" : ""}`}
            role="button"
            tabIndex={0}
            aria-haspopup="dialog"
            aria-expanded={isHighCentralityPopoverOpen}
            onClick={() => setHighCentralityPopoverOpen((current) => !current)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                setHighCentralityPopoverOpen((current) => !current);
              }
            }}
          >
            <span className="summary-label">High-centrality entities</span>
            <strong>{highCentralityEntities.length}</strong>
            {isHighCentralityPopoverOpen && (
              <div className="summary-popover" role="dialog" aria-label="High-centrality entities" onClick={(event) => event.stopPropagation()}>
                <div className="summary-popover-header">
                  <span>HIGH-CENTRALITY ENTITIES ({highCentralityEntities.length})</span>
                </div>
                {highCentralityEntityDetails.length === 0 ? (
                  <div className="summary-popover-empty">No high-centrality entities found for this case.</div>
                ) : (
                  <ul className="high-centrality-list">
                    {highCentralityEntityDetails.map((entity, index) => (
                      <li key={entity.id} className="high-centrality-item">
                        <button
                          type="button"
                          className="high-centrality-button"
                          onClick={(event) => {
                            event.stopPropagation();
                            const targetNode = nodes.find((node) => node.id === entity.id);
                            if (targetNode) {
                              setHighCentralityPopoverOpen(false);
                              focusNode(targetNode);
                            }
                          }}
                        >
                          <span className="high-centrality-rank">{index + 1}.</span>
                          <span className="high-centrality-name">{entity.label || entity.name || entity.id}</span>
                          <span className="high-centrality-meta">— {entity.id} — {entity.type}</span>
                          <span className="high-centrality-detail">Centrality: {Number(entity.centrality || 0).toFixed(2)}</span>
                          <span className="high-centrality-detail">Connections: {entity.connectedEntities}</span>
                          <span className="high-centrality-detail">Direct relationships: {entity.directRelationships}</span>
                          {entity.communityId !== null && entity.communityId !== undefined ? (
                            <span className="high-centrality-detail">Community: {entity.communityId}</span>
                          ) : null}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        </section>

        <section className="network-workspace">
          <div className="network-main-panel">
            <NetworkToolbar
              searchTerm={searchTerm}
              onSearchChange={handleSearchChange}
              onSearchSubmit={handleSearchSubmit}
              onFitGraph={handleFitGraph}
              onZoomIn={handleZoomIn}
              onZoomOut={handleZoomOut}
              onResetView={handleResetView}
              onClearSearch={handleClearSearch}
              onSuggestionSelect={handleSuggestionSelect}
              suggestions={searchSuggestions}
              searchMessage={searchMessage}
              semanticLoading={semanticLoading}
              currentZoom={currentZoom}
              isDisabled={!graphCy || !caseId}
              showPredicted={showPredicted}
              onTogglePredicted={setShowPredicted}
              predictedCount={predictedCount}
            />
            <SearchResults result={semanticResult} nodes={nodes} onFocusResult={focusResultInGraph} />
            <SearchHistory entries={searchHistory} onSelect={restoreSearch} />

            <div className="network-legend-row">
              <NetworkLegend types={graphEntityTypes} predictedCount={predictedCount} alertedCount={Object.keys(alertSeverityByNode).length} crossCaseCount={crossCaseCount} />
            </div>

            <div className="network-graph-shell">
              {loading ? (
                <div className="network-empty-state"><div className="network-empty-title">Loading network...</div></div>
              ) : error ? (
                <div className="network-empty-state error"><div className="network-empty-title">Unable to load network</div></div>
              ) : !caseId ? (
                <div className="network-empty-state"><div className="network-empty-title">Select Case</div></div>
              ) : !nodes.length ? (
                <div className="network-empty-state"><div className="network-empty-title">No network data available</div></div>
              ) : (
                <NetworkGraph
                  nodes={nodes}
                  edges={visibleEdges}
                  alertSeverityByNode={alertSeverityByNode}
                  selectedNodeId={selectedNode?.id || null}
                  selectedEdgeId={selectedEdge?.id || null}
                  searchNodeId={searchNodeId}
                  searchNodeIds={semanticResult?.highlightedNodeIds || []}
                  searchEdgeIds={semanticResult?.highlightedEdgeIds || []}
                  searchTargetNodeId={semanticResult?.searchTargetNodeId || null}
                  onNodeSelect={(node) => {
                    setSelectedNode(node);
                    setSelectedEdge(null);
                  }}
                  onEdgeSelect={(edge) => {
                    setSelectedEdge(edge);
                    setSelectedNode(null);
                  }}
                  onReady={(cy) => {
                    setGraphCy(cy);
                    setCurrentZoom(cy.zoom());
                  }}
                  onZoomChange={setCurrentZoom}
                />
              )}
            </div>
          </div>

          <aside className="network-inspector">
            {selectedEdge && !selectedNode ? (
              <RelationshipPanel
                edge={selectedEdge}
                sourceNode={selectedEdgeSource}
                targetNode={selectedEdgeTarget}
                phoneNode={selectedCallPhone}
                phoneNumber={selectedCallPhoneNumber}
                onPhoneSelect={handlePhoneSelect}
                evidence={evidenceRecords}
                evidenceLoading={evidenceLoading}
                onTraceEvidence={handleTraceEvidence}
              />
            ) : (
              <EntityInvestigationPanel
                entity={selectedEntity}
                relationshipRows={relationshipRows}
                alert={selectedAlert}
                onClose={handleCloseInvestigation}
                evidence={evidenceRecords}
                evidenceLoading={evidenceLoading}
                onTraceEvidence={handleTraceEvidence}
                caseId={caseId}
                crossCaseMatches={selectedCrossCaseMatches}
                onSwitchCase={handleSwitchCase}
              />
            )}
            <InvestigationSummary
              entity={selectedEntity}
              relationships={relationshipRows}
              alerts={selectedNode ? alerts.filter((alert) => alert.entity_id === selectedNode.id) : []}
              evidence={evidenceRecords}
            />
          </aside>
        </section>

        <section className="entity-type-panel">
          <div className="panel-header-row">
            <div>
              <div className="entity-type">Network intelligence</div>
              <h3>Entity distribution</h3>
            </div>
          </div>
          <div className="entity-stat-grid">
            {graphEntityTypes.map((type) => (
              <div key={type} className="entity-stat-card">
                <span>{type}</span>
                <strong>{entitySummary[type]}</strong>
              </div>
            ))}
          </div>
        </section>
      </>
  );

  return (
    <AppLayout title="Network Explorer" subtitle="Investigation workspace">
      {content}
    </AppLayout>
  );
}
