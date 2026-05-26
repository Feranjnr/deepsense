#[allow(lint(public_entry))]
module risk_guardian::risk_guardian {
    // ─── Imports ────────────────────────────────────────────────────────
    use sui::event;
    use sui::clock::Clock;

    // ─── Error codes ────────────────────────────────────────────────────
    const E_NOT_ADMIN: u64 = 0;
    const E_NOT_AGENT: u64 = 1;
    const E_ALREADY_PAUSED: u64 = 2;
    const E_NOT_PAUSED: u64 = 3;
    const E_INVALID_RISK_SCORE: u64 = 4;
    const E_BUDGET_EXCEEDED: u64 = 5;
    const E_AGENT_REVOKED: u64 = 6;

    // ─── Core object: RiskPolicy ────────────────────────────────────────
    // This is the shared on-chain object that holds all risk parameters.
    // It's shared so both the AI agent and admin can access it.
    public struct RiskPolicy has key {
        id: UID,
        // Who controls this policy
        admin: address,
        agent: address,
        agent_active: bool,
        // Risk state
        risk_score: u64,        // 0-100, set by AI
        is_paused: bool,        // protocol pause state
        // Protocol parameters the AI can adjust
        max_leverage: u64,      // basis points (e.g. 500 = 5x)
        liquidation_threshold: u64, // basis points (e.g. 8000 = 80%)
        // Agent budget/limits
        actions_remaining: u64, // how many actions agent can take before needing reset
        max_actions: u64,       // ceiling per period
        // Metadata
        created_at: u64,
        last_action_at: u64,
        total_actions: u64,
    }

    // ─── Admin capability ───────────────────────────────────────────────
    // Only the creator gets this. It proves you're the admin.
    public struct AdminCap has key, store {
        id: UID,
        policy_id: ID,
    }

    // ─── Events (on-chain audit log) ────────────────────────────────────
    // Every action the AI takes emits one of these events.
    // They are permanent, queryable, and visible on Sui Explorer.

    public struct PolicyCreated has copy, drop {
        policy_id: ID,
        admin: address,
        agent: address,
        max_leverage: u64,
        liquidation_threshold: u64,
        timestamp: u64,
    }

    public struct RiskScoreUpdated has copy, drop {
        policy_id: ID,
        old_score: u64,
        new_score: u64,
        agent: address,
        timestamp: u64,
    }

    public struct ProtocolPaused has copy, drop {
        policy_id: ID,
        risk_score: u64,
        agent: address,
        timestamp: u64,
    }

    public struct ProtocolResumed has copy, drop {
        policy_id: ID,
        resumed_by: address,
        timestamp: u64,
    }

    public struct ParametersAdjusted has copy, drop {
        policy_id: ID,
        old_max_leverage: u64,
        new_max_leverage: u64,
        old_liquidation_threshold: u64,
        new_liquidation_threshold: u64,
        agent: address,
        timestamp: u64,
    }

    public struct AgentRevoked has copy, drop {
        policy_id: ID,
        revoked_agent: address,
        admin: address,
        timestamp: u64,
    }

    public struct AgentUpdated has copy, drop {
        policy_id: ID,
        old_agent: address,
        new_agent: address,
        admin: address,
        timestamp: u64,
    }

    public struct AdminOverride has copy, drop {
        policy_id: ID,
        action: vector<u8>,
        admin: address,
        timestamp: u64,
    }

    // ─── Create a new RiskPolicy ────────────────────────────────────────
    // Called once to set up the guardian. Creates the shared policy object
    // and gives the caller an AdminCap.
    public entry fun create_policy(
        agent: address,
        max_leverage: u64,
        liquidation_threshold: u64,
        max_actions: u64,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        let sender = ctx.sender();
        let now = clock.timestamp_ms();

        let policy = RiskPolicy {
            id: object::new(ctx),
            admin: sender,
            agent,
            agent_active: true,
            risk_score: 0,
            is_paused: false,
            max_leverage,
            liquidation_threshold,
            actions_remaining: max_actions,
            max_actions,
            created_at: now,
            last_action_at: now,
            total_actions: 0,
        };

        let policy_id = object::id(&policy);

        let admin_cap = AdminCap {
            id: object::new(ctx),
            policy_id,
        };

        event::emit(PolicyCreated {
            policy_id,
            admin: sender,
            agent,
            max_leverage,
            liquidation_threshold,
            timestamp: now,
        });

        transfer::share_object(policy);
        transfer::transfer(admin_cap, sender);
    }

    // ─── Agent actions ──────────────────────────────────────────────────

    // AI agent updates the risk score (0-100)
    public entry fun update_risk_score(
        policy: &mut RiskPolicy,
        new_score: u64,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        let sender = ctx.sender();
        assert!(sender == policy.agent, E_NOT_AGENT);
        assert!(policy.agent_active, E_AGENT_REVOKED);
        assert!(new_score <= 100, E_INVALID_RISK_SCORE);
        assert!(policy.actions_remaining > 0, E_BUDGET_EXCEEDED);

        let old_score = policy.risk_score;
        policy.risk_score = new_score;
        policy.actions_remaining = policy.actions_remaining - 1;
        policy.last_action_at = clock.timestamp_ms();
        policy.total_actions = policy.total_actions + 1;

        event::emit(RiskScoreUpdated {
            policy_id: object::id(policy),
            old_score,
            new_score,
            agent: sender,
            timestamp: clock.timestamp_ms(),
        });
    }

    // AI agent pauses the protocol when risk is critical
    public entry fun pause_protocol(
        policy: &mut RiskPolicy,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        let sender = ctx.sender();
        assert!(sender == policy.agent, E_NOT_AGENT);
        assert!(policy.agent_active, E_AGENT_REVOKED);
        assert!(!policy.is_paused, E_ALREADY_PAUSED);
        assert!(policy.actions_remaining > 0, E_BUDGET_EXCEEDED);

        policy.is_paused = true;
        policy.actions_remaining = policy.actions_remaining - 1;
        policy.last_action_at = clock.timestamp_ms();
        policy.total_actions = policy.total_actions + 1;

        event::emit(ProtocolPaused {
            policy_id: object::id(policy),
            risk_score: policy.risk_score,
            agent: sender,
            timestamp: clock.timestamp_ms(),
        });
    }

    // AI agent adjusts protocol parameters
    public entry fun adjust_parameters(
        policy: &mut RiskPolicy,
        new_max_leverage: u64,
        new_liquidation_threshold: u64,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        let sender = ctx.sender();
        assert!(sender == policy.agent, E_NOT_AGENT);
        assert!(policy.agent_active, E_AGENT_REVOKED);
        assert!(policy.actions_remaining > 0, E_BUDGET_EXCEEDED);

        let old_max_leverage = policy.max_leverage;
        let old_liquidation_threshold = policy.liquidation_threshold;

        policy.max_leverage = new_max_leverage;
        policy.liquidation_threshold = new_liquidation_threshold;
        policy.actions_remaining = policy.actions_remaining - 1;
        policy.last_action_at = clock.timestamp_ms();
        policy.total_actions = policy.total_actions + 1;

        event::emit(ParametersAdjusted {
            policy_id: object::id(policy),
            old_max_leverage,
            new_max_leverage,
            old_liquidation_threshold,
            new_liquidation_threshold,
            agent: sender,
            timestamp: clock.timestamp_ms(),
        });
    }

    // ─── Admin overrides ────────────────────────────────────────────────

    // Admin resumes a paused protocol (overrides AI decision)
    public entry fun admin_resume(
        policy: &mut RiskPolicy,
        _cap: &AdminCap,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        assert!(ctx.sender() == policy.admin, E_NOT_ADMIN);
        assert!(policy.is_paused, E_NOT_PAUSED);

        policy.is_paused = false;

        event::emit(ProtocolResumed {
            policy_id: object::id(policy),
            resumed_by: ctx.sender(),
            timestamp: clock.timestamp_ms(),
        });

        event::emit(AdminOverride {
            policy_id: object::id(policy),
            action: b"resume_protocol",
            admin: ctx.sender(),
            timestamp: clock.timestamp_ms(),
        });
    }

    // Admin revokes agent access entirely
    public entry fun revoke_agent(
        policy: &mut RiskPolicy,
        _cap: &AdminCap,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        assert!(ctx.sender() == policy.admin, E_NOT_ADMIN);

        let old_agent = policy.agent;
        policy.agent_active = false;

        event::emit(AgentRevoked {
            policy_id: object::id(policy),
            revoked_agent: old_agent,
            admin: ctx.sender(),
            timestamp: clock.timestamp_ms(),
        });
    }

    // Admin sets a new agent address
    public entry fun update_agent(
        policy: &mut RiskPolicy,
        new_agent: address,
        _cap: &AdminCap,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        assert!(ctx.sender() == policy.admin, E_NOT_ADMIN);

        let old_agent = policy.agent;
        policy.agent = new_agent;
        policy.agent_active = true;
        policy.actions_remaining = policy.max_actions;

        event::emit(AgentUpdated {
            policy_id: object::id(policy),
            old_agent,
            new_agent,
            admin: ctx.sender(),
            timestamp: clock.timestamp_ms(),
        });
    }

    // Admin resets the agent's action budget
    public entry fun reset_agent_budget(
        policy: &mut RiskPolicy,
        _cap: &AdminCap,
        ctx: &mut TxContext,
    ) {
        assert!(ctx.sender() == policy.admin, E_NOT_ADMIN);
        policy.actions_remaining = policy.max_actions;
    }

    // Admin force-adjusts parameters (override AI settings)
    public entry fun admin_adjust_parameters(
        policy: &mut RiskPolicy,
        new_max_leverage: u64,
        new_liquidation_threshold: u64,
        _cap: &AdminCap,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        assert!(ctx.sender() == policy.admin, E_NOT_ADMIN);

        policy.max_leverage = new_max_leverage;
        policy.liquidation_threshold = new_liquidation_threshold;

        event::emit(AdminOverride {
            policy_id: object::id(policy),
            action: b"adjust_parameters",
            admin: ctx.sender(),
            timestamp: clock.timestamp_ms(),
        });
    }

    // ─── View functions (read-only) ─────────────────────────────────────

    public fun risk_score(policy: &RiskPolicy): u64 { policy.risk_score }
    public fun is_paused(policy: &RiskPolicy): bool { policy.is_paused }
    public fun max_leverage(policy: &RiskPolicy): u64 { policy.max_leverage }
    public fun liquidation_threshold(policy: &RiskPolicy): u64 { policy.liquidation_threshold }
    public fun agent(policy: &RiskPolicy): address { policy.agent }
    public fun agent_active(policy: &RiskPolicy): bool { policy.agent_active }
    public fun actions_remaining(policy: &RiskPolicy): u64 { policy.actions_remaining }
    public fun total_actions(policy: &RiskPolicy): u64 { policy.total_actions }
    public fun admin(policy: &RiskPolicy): address { policy.admin }
    public fun last_action_at(policy: &RiskPolicy): u64 { policy.last_action_at }
}
