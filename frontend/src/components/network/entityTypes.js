export const ENTITY_TYPE_CONFIG = {
  PERSON: { color: "#7dd3fc", shape: "ellipse", icon: '<circle cx="16" cy="9" r="4"/><path d="M7 25c.8-5 3.8-8 9-8s8.2 3 9 8"/>' },
  PHONE: { color: "#a78bfa", shape: "roundrectangle", icon: '<rect x="10" y="3" width="12" height="26" rx="2"/><path d="M14 7h4M15 25h2"/>' },
  VEHICLE: { color: "#fbbf24", shape: "rectangle", icon: '<path d="M5 21h22l-2-7H9l-4 7Z"/><path d="m9 14 2-5h9l3 5M8 24h3M21 24h3"/><circle cx="9" cy="22" r="2"/><circle cx="23" cy="22" r="2"/>' },
  DEVICE: { color: "#60a5fa", shape: "rectangle", icon: '<rect x="5" y="5" width="22" height="15" rx="1"/><path d="M3 25h26M12 25l1-5h6l1 5"/>' },
  LOCATION: { color: "#4ade80", shape: "diamond", icon: '<path d="M6 26V7h20v19M4 26h24M11 12h3M18 12h3M11 18h3M18 18h3M11 26v-4h10v4"/>' },
  ORGANIZATION: { color: "#fda4af", shape: "hexagon", icon: '<path d="M5 27V8l11-5 11 5v19M3 27h26M10 12h2M18 12h2M10 17h2M18 17h2M10 22h2M18 22h2M15 27v-5h2v5"/>' },
  EVENT: { color: "#34d399", shape: "octagon", icon: '<rect x="5" y="6" width="22" height="21" rx="2"/><path d="M9 3v6M23 3v6M5 12h22M10 17h2M15 17h2M20 17h2M10 22h2M15 22h2"/>' },
  ACCOUNT: { color: "#f0abfc", shape: "roundrectangle", icon: '<rect x="4" y="8" width="24" height="17" rx="2"/><path d="M4 13h24M9 20h6"/>' },
  EMAIL: { color: "#5eead4", shape: "roundrectangle", icon: '<rect x="4" y="7" width="24" height="18" rx="2"/><path d="m4 8 12 10L28 8"/>' },
  SOCIAL_ID: { color: "#93c5fd", shape: "ellipse", icon: '<circle cx="16" cy="16" r="12"/><circle cx="16" cy="15" r="5"/><path d="M11 24c1-3 3-4 5-4s4 1 5 4"/>' },
  MONEY: { color: "#86efac", shape: "ellipse", icon: '<circle cx="16" cy="16" r="12"/><path d="M16 9v14M12 12.5c0-1.5 1.6-2.5 4-2.5s4 1 4 2.5-1.6 2.5-4 2.5-4 1-4 2.5 1.6 2.5 4 2.5 4-1 4-2.5"/>' },
  WEAPON: { color: "#fca5a5", shape: "triangle", icon: '<path d="M16 5 27 25H5Z"/><path d="M16 13v6M16 21.5v.5"/>' },
  DRUG: { color: "#fdba74", shape: "rectangle", icon: '<rect x="6" y="13" width="20" height="8" rx="4" transform="rotate(-25 16 17)"/><path d="M13 10.5 19 23.5" stroke-dasharray="1 3"/>' },
  CRIME: { color: "#f87171", shape: "octagon", icon: '<circle cx="16" cy="16" r="12"/><path d="M16 9v8"/><circle cx="16" cy="22" r="1.2" fill="currentColor" stroke="none"/>' },
  UNKNOWN: { color: "#94a3b8", shape: "ellipse", icon: null },
};

export const ENTITY_TYPES = Object.keys(ENTITY_TYPE_CONFIG).filter((type) => type !== "UNKNOWN");

export function normalizeEntityType(type) {
  const normalizedType = String(type || "").trim().toUpperCase();
  return ENTITY_TYPE_CONFIG[normalizedType] ? normalizedType : "UNKNOWN";
}

export function getEntityTypeConfig(type) {
  return ENTITY_TYPE_CONFIG[normalizeEntityType(type)];
}
