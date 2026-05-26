// RiskGuardian contract addresses — Sui Testnet
// Deployed: May 2026

export const RISK_GUARDIAN = {
  // The deployed Move package
  PACKAGE_ID: "0xfa8f2cc06832e8ea02b2c92cf83a72815feb7a5433918ba1aeb275425dce14bd",

  // The shared RiskPolicy object
  POLICY_ID: "0x3ee09dcedb3a71366640368320ed4c586299a9b7dd0ace7246727b1a0994c726",

  // Admin capability (owned by deployer)
  ADMIN_CAP_ID: "0xb052d42d2fd1f725609b431db0ab93dbbdd8a4f5cda7d13fc58c6cdf1d1e7896",

  // Module name
  MODULE: "risk_guardian",

  // Network
  NETWORK: "testnet",

  // Sui system clock (always 0x6)
  CLOCK: "0x6",
} as const

// Event type strings for querying on-chain events
export const RISK_EVENTS = {
  PolicyCreated: `${RISK_GUARDIAN.PACKAGE_ID}::${RISK_GUARDIAN.MODULE}::PolicyCreated`,
  RiskScoreUpdated: `${RISK_GUARDIAN.PACKAGE_ID}::${RISK_GUARDIAN.MODULE}::RiskScoreUpdated`,
  ProtocolPaused: `${RISK_GUARDIAN.PACKAGE_ID}::${RISK_GUARDIAN.MODULE}::ProtocolPaused`,
  ProtocolResumed: `${RISK_GUARDIAN.PACKAGE_ID}::${RISK_GUARDIAN.MODULE}::ProtocolResumed`,
  ParametersAdjusted: `${RISK_GUARDIAN.PACKAGE_ID}::${RISK_GUARDIAN.MODULE}::ParametersAdjusted`,
  AgentRevoked: `${RISK_GUARDIAN.PACKAGE_ID}::${RISK_GUARDIAN.MODULE}::AgentRevoked`,
  AgentUpdated: `${RISK_GUARDIAN.PACKAGE_ID}::${RISK_GUARDIAN.MODULE}::AgentUpdated`,
  AdminOverride: `${RISK_GUARDIAN.PACKAGE_ID}::${RISK_GUARDIAN.MODULE}::AdminOverride`,
} as const
