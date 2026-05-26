"use client";

import { useEffect, useState, useCallback } from "react";
import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc";
import { RISK_GUARDIAN } from "@/app/config/contracts";

const suiClient = new SuiJsonRpcClient({
  url: getJsonRpcFullnodeUrl("testnet"),
  network: "testnet",
});

export type PolicyState = {
  risk_score: number;
  is_paused: boolean;
  max_leverage: number;
  liquidation_threshold: number;
  agent: string;
  agent_active: boolean;
  admin: string;
  actions_remaining: number;
  max_actions: number;
  total_actions: number;
  last_action_at: number;
  created_at: number;
};

export type RiskEvent = {
  type: string;
  parsedJson: unknown;
  timestampMs: string | null | undefined;
  txDigest: string;
};

export function useRiskGuardian() {
  const [policyState, setPolicyState] = useState<PolicyState | null>(null);
  const [events, setEvents] = useState<RiskEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchPolicy = useCallback(async () => {
    const response = await suiClient.getObject({
      id: RISK_GUARDIAN.POLICY_ID,
      options: { showContent: true },
    });

    const content = response.data?.content;
    if (!content || content.dataType !== "moveObject") {
      throw new Error("Unexpected object content type");
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const f = content.fields as Record<string, any>;

    setPolicyState({
      risk_score: Number(f.risk_score),
      is_paused: f.is_paused === true || f.is_paused === "true",
      max_leverage: Number(f.max_leverage),
      liquidation_threshold: Number(f.liquidation_threshold),
      agent: String(f.agent),
      agent_active: f.agent_active === true || f.agent_active === "true",
      admin: String(f.admin),
      actions_remaining: Number(f.actions_remaining),
      max_actions: Number(f.max_actions),
      total_actions: Number(f.total_actions),
      last_action_at: Number(f.last_action_at),
      created_at: Number(f.created_at),
    });
  }, []);

  const fetchEvents = useCallback(async () => {
    const result = await suiClient.queryEvents({
      query: {
        MoveModule: {
          package: RISK_GUARDIAN.PACKAGE_ID,
          module: RISK_GUARDIAN.MODULE,
        },
      },
      order: "descending",
      limit: 50,
    });

    setEvents(
      result.data.map((event: import("@mysten/sui/jsonRpc").SuiEvent) => ({
        type: event.type,
        parsedJson: event.parsedJson,
        timestampMs: event.timestampMs,
        txDigest: event.id.txDigest,
      }))
    );
  }, []);

  const refetch = useCallback(() => {
    fetchPolicy().catch((e) => setError(String(e)));
    fetchEvents().catch((e) => setError(String(e)));
  }, [fetchPolicy, fetchEvents]);

  useEffect(() => {
    setLoading(true);
    Promise.all([fetchPolicy(), fetchEvents()])
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));

    const interval = setInterval(refetch, 10_000);
    return () => clearInterval(interval);
  }, [fetchPolicy, fetchEvents, refetch]);

  return { policyState, events, loading, error, refetch };
}
