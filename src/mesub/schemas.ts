import * as z from 'zod';

import { clip } from '../text.js';
import { snake } from '../tools/snake.js';
import { isLink } from './link.js';

// What the tools read from the Mesub API, one schema per answer. An answer is
// parsed against its schema before a tool sees it: unknown fields are dropped.

/** `GET /health`. */
export const apiHealthSchema = z.object({
    // What the API calls its own state: a word, cut short if it is not.
    status: z.string().transform((value) => clip(value, 100)),
    /** Seconds since the API process started. */
    uptime: z.number(),
});
export type ApiHealth = z.infer<typeof apiHealthSchema>;

/** `GET /agent/whoami`: the connection an agent's access token stands for. */
export const agentWhoamiSchema = z.object({
    connection_id: z.string().min(1).max(200),
    // Null: the connection reaches every project of its organization.
    project: z.object({ id: z.string().min(1).max(200), name: z.string().max(500) }).nullable(),
    // Absent from an API older than organizations: null then.
    organization: z
        .object({ id: z.string().min(1).max(200), name: z.string().max(500) })
        .nullish()
        .default(null),
    // Whether the connection is held to `project`. Absent from an older API: null then.
    pinned: z.boolean().nullish().default(null),
    client: z.object({ id: z.string().max(2048), name: z.string().max(500) }),
    scope: z.string().max(500),
    /** Who the token is for: this server's own resource URL, which it checks. */
    audience: z.string().max(2048),
    issuer: z.string().max(2048),
    /** When the access token stops working, in seconds since the epoch. */
    expires_at: z
        .number()
        .positive()
        .max(Number.MAX_SAFE_INTEGER / 1000),
});
export type AgentWhoami = z.infer<typeof agentWhoamiSchema>;

// The routes under /agent that read and change the projects of the connection. An
// answer that does not fit is refused whole (`unexpected`), never passed on.
// Unknown fields are dropped, as above: the API may add one tomorrow, and it
// reaches no agent until a schema here names it. Texts somebody else wrote are
// cut short on the way in, so every tool is handed bounded data.
//
// Types, lengths and what may be null are held strictly. The VALUES of a list
// the API may grow (a status, an outcome, an event) are not: see `code()`.

export const PLAN_STATUSES = ['PENDING', 'ACTIVE', 'SUNSET', 'FAILED', 'CLOSED'] as const;
export const SUBSCRIPTION_STATUSES = [
    'PENDING',
    'ACTIVE',
    'CANCELLED',
    'UNPAID',
    'STOPPED',
    'ENDED',
    'FAILED',
    'EXPIRED',
    'SUPERSEDED',
] as const;
export const TIERS = ['FREE', 'DEV', 'BUSINESS'] as const;
/** A person's place in an organization, read on every call. */
export const ROLES = ['OWNER', 'ADMIN', 'MEMBER'] as const;
export const PULL_OUTCOMES = ['PAID', 'SKIPPED', 'REJECTED', 'BLOCKED'] as const;
export const SUBSCRIPTION_BUCKETS = [
    'all',
    'active',
    'late',
    'stopped',
    'cancelled',
    'new',
] as const;
export const ACCESS_STATUSES = [
    'pending',
    'active',
    'cancelled',
    'unpaid',
    'stopped',
    'ended',
    'failed',
    'superseded',
    'none',
] as const;
export const PAYMENT_STATUSES = ['paid', 'late', 'none'] as const;
/** Why charges are blocked: the first five are the merchant's own setup, `mesub` is ours. */
export const BLOCKED_REASONS = [
    'puller_not_allowed',
    'receiver_not_allowed',
    'receiver_account_missing',
    'receiver_account_frozen',
    'mint_gone',
    'mesub',
] as const;
/** Why a subscription ended, as `/v1/access` spells it. */
export const END_REASONS = [
    'cancelled',
    'plan_removed',
    'plan_replaced',
    'plan_ended',
    'closed_elsewhere',
    'closed',
] as const;
/** Why Mesub stopped charging a subscription, as `/v1/access` spells it. */
export const STOP_REASONS = [
    'out_of_retries',
    'retry_deadline_passed',
    'authority_closed',
] as const;
export const UPCOMING_KINDS = ['charge', 'retry', 'ends'] as const;
export const DELIVERY_STATUSES = ['PENDING', 'DELIVERED', 'FAILED'] as const;
export const EVENT_GROUPS = ['all', 'payments', 'subscribers', 'account'] as const;
export const EVENT_BUCKETS = ['day', 'week', 'month'] as const;
export const OVERVIEW_DAYS = [7, 30, 90] as const;
export const WEBHOOK_EVENTS = [
    'subscription.created',
    'subscription.renewal_upcoming',
    'subscription.renewed',
    'subscription.payment_failed',
    'subscription.stopped',
    'subscription.cancelled',
    'subscription.resumed',
    'subscription.ended',
    'subscription.expired',
    'subscription.access_granted',
    'subscription.access_revoked',
    'subscription.paused',
    'subscription.unpaused',
] as const;

/** How long a text somebody else wrote may be before it is cut. */
export const MAX_NAME_LENGTH = 200;
export const MAX_DESCRIPTION_LENGTH = 1000;
export const MAX_REASON_LENGTH = 300;
export const MAX_EXCERPT_LENGTH = 500;
export const MAX_DETAIL_LENGTH = 1000;
/** The merchant's own id for a customer: the API takes 255 characters at most. */
export const MAX_EXTERNAL_ID_LENGTH = 255;
/** Past the four wallets a plan locks, whatever the API comes to allow. */
export const MAX_DESTINATIONS_READ = 16;
/** Past any list of events an endpoint takes, whatever the API adds. */
export const MAX_WEBHOOK_EVENTS = 64;
/** An address is kept whole or refused: one cut short is another address. */
export const MAX_URL_LENGTH = 2048;
/** What a token calls itself is free text on chain: cut like any other. */
export const MAX_TOKEN_SYMBOL_LENGTH = 40;
export const MAX_TOKEN_NAME_LENGTH = 100;
/** A logo's address past this is dropped, never cut. */
export const MAX_TOKEN_LOGO_LENGTH = 512;

const id = z.string().min(1).max(200);
/** An address, a signature, a slug: kept whole or refused, never cut. */
const plain = z.string().max(200);
const text = (max: number) => z.string().transform((value) => clip(value, max));
/** A token amount in the mint's smallest unit. */
const amount = z.string().min(1).max(80);
/** Dollars, as a decimal string. */
const usd = z.string().min(1).max(80);
/** ISO 8601, UTC. */
const date = z.string().min(1).max(64);
const count = z.number().int();
/** Null: unknown, never zero. */
const decimals = z.number().int().min(0).max(36).nullable();
/**
 * What a mint is called, served beside its decimals: null for a token Mesub
 * does not vouch for, and for an API older than the field.
 */
const symbol = z
    .string()
    .max(20)
    .nullish()
    .transform((value) => value ?? null);
/** An address with no blank in it: what a logo's must be to be passed on. */
const LOGO = /^[\x21-\x7e]+$/;
/**
 * What Mesub found for a mint, served beside it: its symbol, its name and its
 * logo, written by whoever made the token, and whether it is verified. The
 * texts are cut like any other. The logo's address is somebody else's too: one
 * too long or holding a blank is dropped, since it may not be cut and is no
 * reason to refuse a plan. Null from an API older than the field.
 */
const token = z
    .object({
        symbol: text(MAX_TOKEN_SYMBOL_LENGTH).nullable(),
        name: text(MAX_TOKEN_NAME_LENGTH).nullable(),
        logoUrl: z
            .string()
            .nullable()
            .transform((value) =>
                value !== null && value.length <= MAX_TOKEN_LOGO_LENGTH && LOGO.test(value)
                    ? value
                    : null,
            ),
        verified: z.boolean(),
    })
    .nullish()
    .transform((value) => value ?? null);
/**
 * A failure in Mesub's own words, served beside its code. Bounded like any
 * other text. Null where there is none, and from an API older than the field.
 */
const reasonLabel = text(MAX_REASON_LENGTH)
    .nullish()
    .transform((value) => value ?? null);

/** What every value of such a list looks like: one short plain word. */
const CODE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
/** What stands for a value that is not even that. */
export const UNKNOWN_CODE = 'UNKNOWN';

/**
 * A value out of a list the API may grow: a status, a tier, an outcome, a
 * kind, the name of an event. A value added since this server was written
 * must not fail the tool, so none is refused: one that is a short plain word
 * is kept as it is, and any other string becomes `UNKNOWN`. A tool's sentence
 * never says one it does not know: it goes through `known()` (src/text.ts).
 */
const code = () => z.string().transform((value) => (CODE.test(value) ? value : UNKNOWN_CODE));
/** How many there are of each value of such a list. A key that is not a plain word is dropped. */
const countsByCode = () =>
    z
        .record(z.string(), count)
        .transform((counts) =>
            Object.fromEntries(Object.entries(counts).filter(([key]) => CODE.test(key))),
        );
/** An address of the dashboard, kept whole or refused: see `isLink`. */
const link = z.string().refine(isLink);
/**
 * The merchant's own id for a customer, as their server gave it: text somebody
 * else wrote, kept whole or refused, never cut (one cut short is another id).
 * Null when none was given, and from an API older than the field. Never the
 * customer's email, which no schema here reads.
 */
const externalId = z
    .string()
    .max(MAX_EXTERNAL_ID_LENGTH)
    .nullish()
    .transform((value) => value ?? null);
/** Where a PENDING plan is signed; null on any other, and from an API older than the field. */
const signUrl = link.nullish().transform((value) => value ?? null);
/** Its entry in To sign, where the organization wallet signs it: as `signUrl`, null from an older API. */
const toSignUrl = link.nullish().default(null);
/** The organization of a plan: its name was written by a person. Null from an older API. */
const organization = z
    .object({ id, name: text(MAX_NAME_LENGTH) })
    .nullish()
    .default(null);

/**
 * The project a write acted on, as its answer echoes it (teams v1): its id,
 * and its name as stored when the call began, kept whole to be compared with
 * the one named. Null from an API older than the echo.
 */
const projectEcho = z
    .object({ id, name: z.string().max(500) })
    .nullish()
    .default(null);
export type ProjectEcho = NonNullable<z.infer<typeof projectEcho>>;

/**
 * Which project a row is of (teams v1): what tells apart the rows of a read
 * across an organization. The name is null for a project deleted during the
 * call, and both are null from an API older than them.
 */
const ofProject = {
    projectId: id.nullish().default(null),
    projectName: text(MAX_NAME_LENGTH).nullish().default(null),
};

const planStatus = code();
const subscriptionStatus = code();
const tier = code();

const servedProjectSchema = z.object({
    id,
    name: text(MAX_NAME_LENGTH),
    tier,
    billing: z
        .object({
            subscriptionId: id,
            status: subscriptionStatus,
            nextChargeAt: date.nullable(),
            endsAt: date.nullable(),
        })
        .nullable(),
    plans: count,
    planCap: count.nullable(),
    // Written by the merchant: an address to show, never fetched. Null on an older API.
    manageUrl: z
        .string()
        .max(MAX_URL_LENGTH)
        .nullish()
        .transform((value) => value ?? null),
    createdAt: date,
    updatedAt: date,
});
const metered = z.object({ used: count, cap: count.nullable() });

/** `GET /agent/project`. */
export const agentProjectSchema = z.object({
    project: servedProjectSchema,
    usage: z.object({
        projectId: id,
        tier,
        plans: metered,
        subscribers: metered,
        byPlan: z.array(
            z.object({
                planId: id,
                slug: plain.nullable(),
                name: text(MAX_NAME_LENGTH).nullable(),
                status: planStatus,
                holdsSlot: z.boolean(),
                subscribers: count,
                collectedThisPeriod: amount,
                collectedThisPeriodUsd: usd,
                unpricedThisPeriod: count,
            }),
        ),
    }),
});
export type AgentProject = z.infer<typeof agentProjectSchema>;

/** `PATCH /agent/project`: the project renamed, and the one it acted on, by its name before. */
export const renamedProjectSchema = servedProjectSchema.extend({ project: projectEcho });
export type RenamedProject = z.infer<typeof renamedProjectSchema>;
export type ServedProject = z.infer<typeof servedProjectSchema>;

/**
 * `GET /agent/projects`: the organization the connection reaches, the
 * person's role in it and what the role allows, and every project the
 * connection reaches, newest first, none left out: what `project` takes.
 */
export const agentProjectsSchema = z.object({
    organization: z.object({
        id,
        name: text(MAX_NAME_LENGTH),
        role: code(),
        actions: z.array(code()),
    }),
    pinnedProjectId: id.nullable(),
    projects: z.array(z.object({ id, name: text(MAX_NAME_LENGTH), tier })),
});
export type AgentProjects = z.infer<typeof agentProjectsSchema>;

/** A plan, as every route that answers one serves it. */
export const agentPlanSchema = z.object({
    id,
    slug: plain.nullable(),
    name: text(MAX_NAME_LENGTH).nullable(),
    description: text(MAX_DESCRIPTION_LENGTH).nullable(),
    // Written by the merchant, or by an agent for them: an address to show, never fetched.
    // Absent from an API older than prepared plans: null then.
    websiteUrl: z
        .string()
        .max(MAX_URL_LENGTH)
        .nullish()
        .transform((value) => value ?? null),
    status: planStatus,
    amount,
    mint: plain,
    token,
    symbol: z.string().max(20).nullable(),
    decimals,
    periodHours: z.number(),
    endsAt: date.nullable(),
    retryAttempts: count.nullable(),
    retryDelayMinutes: count.nullable(),
    retryPolicy: z.object({ honoured: z.boolean(), reason: text(MAX_REASON_LENGTH).nullable() }),
    receiver: plain,
    // The only wallets the plan may ever pay, locked once it is signed. Empty: none is locked.
    // Absent from an API older than the list: empty then.
    destinations: z
        .array(plain)
        .max(MAX_DESTINATIONS_READ)
        .nullish()
        .transform((value) => value ?? []),
    receiverMissingSince: date.nullable(),
    createdAt: date,
    confirmedAt: date.nullable(),
    // The agent that prepared it, by the name its application gave itself: text somebody else wrote.
    preparedBy: z
        .object({ clientName: text(MAX_NAME_LENGTH), at: date })
        .nullish()
        .transform((value) => value ?? null),
});
export type AgentPlan = z.infer<typeof agentPlanSchema>;

/** `PATCH /agent/plans/:id/retry-policy`: the plan, and the project it acted on. */
export const retryPolicyPlanSchema = agentPlanSchema.extend({ project: projectEcho });
export type RetryPolicyPlan = z.infer<typeof retryPolicyPlanSchema>;

/** `POST /agent/plans`: the plan just prepared, and where its merchant signs it. */
export const preparedPlanSchema = agentPlanSchema.extend({
    signUrl: link,
    toSignUrl,
    // The wallet that signs it: the organization wallet of its organization. Read, not passed on.
    signer: plain.nullish().default(null),
    organization,
    project: projectEcho,
    nextStep: text(MAX_REASON_LENGTH),
});
export type PreparedPlan = z.infer<typeof preparedPlanSchema>;

/** `GET /agent/plans`. */
export const agentPlansSchema = z.array(
    agentPlanSchema.extend({
        signUrl,
        toSignUrl,
        ...ofProject,
        subscribers: count,
        collectedThisPeriod: amount,
        collectedThisPeriodUsd: usd,
        unpricedThisPeriod: count,
    }),
);
export type AgentListedPlan = z.infer<typeof agentPlansSchema>[number];

/** One charge attempt, as the subscription and the plan routes serve it. */
const attemptSchema = z.object({
    id,
    outcome: code(),
    reason: text(MAX_REASON_LENGTH).nullable(),
    reasonLabel,
    amount,
    amountUsd: usd.nullable(),
    signature: plain.nullable(),
    retry: z.boolean(),
    retryNumber: count.nullable(),
    retriesAllowed: count.nullable(),
    attemptedAt: date,
});
export type AgentAttempt = z.infer<typeof attemptSchema>;

/** `GET /agent/plans/:id`. */
export const agentPlanDetailSchema = z.object({
    plan: agentPlanSchema.extend({ signUrl, toSignUrl, ...ofProject }),
    subscribers: countsByCode(),
    monthly: amount,
    monthlyUsd: usd.nullable(),
    collected: amount,
    collectedUsd: usd,
    unpricedPaid: count,
    outcomes: countsByCode(),
    failures: z.array(z.object({ reason: text(MAX_REASON_LENGTH), reasonLabel, count })),
    upcoming: z.array(
        z.object({
            subscriber: plain,
            externalId,
            dueAt: date,
            failedPulls: count,
            retries: count,
        }),
    ),
    nextPull: z.object({ dueAt: date, amount, manual: z.boolean() }).nullable(),
    attempts: z.array(attemptSchema.extend({ subscriptionId: id, externalId })),
});
export type AgentPlanDetail = z.infer<typeof agentPlanDetailSchema>;

const subscriptionRowSchema = z.object({
    ...ofProject,
    id,
    subscriber: plain,
    externalId,
    planId: id,
    planName: text(MAX_NAME_LENGTH).nullable(),
    status: subscriptionStatus,
    // CANCELLED, PLAN_REMOVED, PLAN_REPLACED, PLAN_ENDED, CLOSED_ELSEWHERE or CLOSED.
    endReason: code().nullable(),
    // INSUFFICIENT_BALANCE, APPROVAL_REVOKED or AUTHORITY_CLOSED.
    lateReason: code().nullable(),
    // On STOPPED: OUT_OF_RETRIES, RETRY_DEADLINE_PASSED or AUTHORITY_CLOSED.
    // Absent from an API older than it: null then.
    stopReason: code()
        .nullish()
        .transform((value) => value ?? null),
    // Whether the subscriber can close it on Solana now, or from when. Absent
    // from an API older than them: false and null then, which say nothing.
    closable: z
        .boolean()
        .nullish()
        .transform((value) => value ?? false),
    closableFrom: date.nullish().transform((value) => value ?? null),
    hasAccess: z.boolean(),
    accessUntil: date.nullable(),
    // As `/agent/access` says a block. Absent from an API older than it: null then.
    blockedSince: date.nullish().transform((value) => value ?? null),
    blockedReason: code()
        .nullish()
        .transform((value) => value ?? null),
    cancelledAt: date.nullable(),
    parkedAt: date.nullable(),
    dueAt: date.nullable(),
    failedPulls: count,
    retriesAllowed: count,
    retryAvailableAt: date.nullable(),
    retryDeadline: date.nullable(),
    retryClosesAt: date.nullable(),
    lastPaidAt: date.nullable(),
    confirmedAt: date.nullable(),
    amount,
    mint: plain,
    token,
    symbol,
    decimals,
});
export type AgentSubscriptionRow = z.infer<typeof subscriptionRowSchema>;

/** `GET /agent/subscriptions`. */
export const agentSubscriptionPageSchema = z.object({
    rows: z.array(subscriptionRowSchema),
    page: count,
    limit: count,
    total: count,
    counts: z.object({
        all: count,
        active: count,
        late: count,
        stopped: count,
        cancelled: count,
        new: count,
    }),
    monthlyUsd: usd,
    lateMonthlyUsd: usd,
    stoppedMonthlyUsd: usd,
});
export type AgentSubscriptionPage = z.infer<typeof agentSubscriptionPageSchema>;

/** `GET /agent/subscriptions/:id`, and what `POST .../retry` answers. */
export const agentSubscriptionSchema = subscriptionRowSchema.extend({
    periodHours: z.number(),
    paid: amount,
    paidUsd: usd.nullable(),
    retryDelayMinutes: count.nullable(),
    attempts: z.array(attemptSchema),
    cameBackAt: date.nullable(),
    firstSubscribedAt: date.nullable(),
    earlier: z.array(
        z.object({
            id,
            status: subscriptionStatus,
            confirmedAt: date.nullable(),
            paid: amount,
            paidUsd: usd.nullable(),
            attempts: z.array(attemptSchema),
        }),
    ),
    supersededBy: id.nullable(),
});
export type AgentSubscription = z.infer<typeof agentSubscriptionSchema>;

/** What `POST /agent/subscriptions/:id/retry` answers: the subscription, and the project it acted on. */
export const retriedSubscriptionSchema = agentSubscriptionSchema.extend({ project: projectEcho });
export type RetriedSubscription = z.infer<typeof retriedSubscriptionSchema>;

/** One answer of `GET /agent/access`: the public `/v1/access` contract, snake_case. */
const accessAnswerSchema = z.object({
    wallet: plain.nullable(),
    plan: plain,
    // The subscription the answer is about. Absent from an API older than it: null then.
    subscription_id: id.nullish().transform((value) => value ?? null),
    access: z.boolean(),
    status: code(),
    paused: z.boolean(),
    end_reason: code().nullable(),
    late_reason: code().nullable(),
    // Absent from an API older than these three: null, false and null then.
    stop_reason: code()
        .nullish()
        .transform((value) => value ?? null),
    closable: z
        .boolean()
        .nullish()
        .transform((value) => value ?? false),
    closable_from: date.nullish().transform((value) => value ?? null),
    payment_status: code(),
    // Set while charges are blocked for a cause that is not the subscriber's.
    // Absent from an API older than the block: null then.
    blocked_since: date.nullish().transform((value) => value ?? null),
    blocked_reason: code()
        .nullish()
        .transform((value) => value ?? null),
    subscribed_since: date.nullable(),
    first_subscribed_at: date.nullable(),
    current_period_end: date.nullable(),
    cancelled_at: date.nullable(),
    access_until: date.nullable(),
    next_charge_at: date.nullable(),
    next_retry_at: date.nullable(),
    retry_deadline: date.nullable(),
    attempts: z
        .array(
            z.object({
                outcome: code(),
                reason: text(MAX_REASON_LENGTH).nullable(),
                reason_label: reasonLabel,
                amount,
                attempted_at: date,
                signature: plain.nullable(),
            }),
        )
        .optional(),
    revalidate_after: z.number(),
});
export type AccessAnswer = z.infer<typeof accessAnswerSchema>;

/** `GET /agent/access` with a plan: one answer. */
export const agentAccessSchema = accessAnswerSchema;
/** `GET /agent/access` without one: every plan of the project the customer has. */
export const agentAccessListSchema = z.object({
    plans: z.array(accessAnswerSchema),
    revalidate_after: z.number(),
});
export type AccessList = z.infer<typeof agentAccessListSchema>;

/** `GET /agent/events` without a day: the days that had anything. */
export const agentEventDaysSchema = z.object({
    days: z.array(
        z.object({
            day: plain,
            pulledUsd: usd,
            failedUsd: usd,
            // Failed charges with no dollar value, outside `failedUsd`. Null: an API older than it.
            failedUnpriced: count.nullish().transform((value) => value ?? null),
        }),
    ),
    page: count,
    hasMore: z.boolean(),
});
export type AgentEventDays = z.infer<typeof agentEventDaysSchema>;

/** `GET /agent/events?day=`: that day in full. */
export const agentEventLinesSchema = z.array(
    z.object({
        ...ofProject,
        id,
        source: code(),
        // An outcome or an event type: a name in capitals, whichever it is.
        type: code(),
        occurredAt: date,
        subscriptionId: id.nullable(),
        subscriber: plain.nullable(),
        externalId,
        planId: id.nullable(),
        planName: text(MAX_NAME_LENGTH).nullable(),
        amount: amount.nullable(),
        amountUsd: usd.nullable(),
        mint: plain.nullable(),
        token,
        symbol,
        decimals,
        reason: text(MAX_REASON_LENGTH).nullable(),
        reasonLabel,
        retry: z.boolean(),
        signature: plain.nullable(),
        // A small JSON object, stored in camelCase: kept as the text of its JSON
        // in snake_case, as the webhooks name the same fields, cut short.
        detail: z
            .unknown()
            .transform((value) =>
                value === null || value === undefined
                    ? null
                    : clip(JSON.stringify(snake(value)), MAX_DETAIL_LENGTH),
            ),
    }),
);
export type AgentEventLine = z.infer<typeof agentEventLinesSchema>[number];

/** `GET /agent/events/upcoming`. */
export const agentUpcomingSchema = z.array(
    z.object({
        ...ofProject,
        subscriptionId: id,
        subscriber: plain,
        externalId,
        planId: id,
        planName: text(MAX_NAME_LENGTH).nullable(),
        kind: code(),
        at: date,
        retry: count,
        retriesAllowed: count,
        amount: amount.nullable(),
        mint: plain,
        token,
        symbol,
        decimals,
        amountUsd: usd.nullable(),
        renewalIssue: code().nullable(),
        renewalCheckedAt: date.nullable(),
        // On a retry: INSUFFICIENT_BALANCE, APPROVAL_REVOKED or AUTHORITY_CLOSED.
        // These three are absent from an API older than them: null then.
        lateReason: code()
            .nullish()
            .transform((value) => value ?? null),
        blockedSince: date.nullish().transform((value) => value ?? null),
        blockedReason: code()
            .nullish()
            .transform((value) => value ?? null),
    }),
);
export type AgentUpcomingLine = z.infer<typeof agentUpcomingSchema>[number];

const totals = z.object({
    collectedUsd: usd,
    attemptedUsd: usd,
    notCollectedUsd: usd,
    pullsSettled: count,
    pullsFailed: count,
    pullsRetried: count,
    retryToCome: count,
    recovered: count,
    notCollected: count,
    unpriced: count,
});

/** `GET /agent/overview`. */
export const agentOverviewSchema = z.object({
    overview: z.object({
        days: z.number(),
        // Whether the tier retries a failed charge by itself. Null: an API older than the field.
        retriesAutomatic: z
            .boolean()
            .nullish()
            .transform((value) => value ?? null),
        // The same for each project the overview covers. Null: an API older than the field.
        retriesAutomaticByProject: z
            .array(
                z.object({
                    projectId: id,
                    projectName: text(MAX_NAME_LENGTH),
                    honoured: z.boolean(),
                }),
            )
            .nullish()
            .default(null),
        totals: z.object({ current: totals, previous: totals }),
        series: z.array(
            z.object({
                day: plain,
                collectedUsd: usd,
                attemptedUsd: usd,
                pullsSettled: count,
                pullsFailed: count,
                pullsRetried: count,
                retryToCome: count,
                recovered: count,
                notCollected: count,
                newSubs: count,
                cancelled: count,
            }),
        ),
        activity: z.array(z.object({ day: plain, pulls: count })),
        cards: z.object({
            activeSubscriptions: count,
            renewalRate: z.number().nullable(),
            expectedUsd: usd,
            upcoming: z.object({ count, amountUsd: usd }),
            late: count,
            stopped: count,
        }),
        nextUp: z.array(
            z.object({
                ...ofProject,
                subscriptionId: id,
                planId: id,
                planName: text(MAX_NAME_LENGTH).nullable(),
                subscriber: plain,
                externalId,
                dueAt: date,
                failedPulls: count,
                retriesAllowed: count,
                amount,
                mint: plain,
                token,
                symbol,
                decimals,
                amountUsd: usd.nullable(),
            }),
        ),
    }),
    collection: z.object({
        days: z.number(),
        collectedUsd: usd,
        previousCollectedUsd: usd,
        attemptedUsd: usd,
        notCollectedUsd: usd,
        failedUsd: usd,
        wonBackUsd: usd,
        stillOwedUsd: usd,
        recoveryRate: z.number().nullable(),
        pullsSettled: count,
        pullsFailed: count,
        pullsRetried: count,
        late: count,
        stopped: count,
        causes: z.array(
            z.object({
                reason: text(MAX_REASON_LENGTH),
                reasonLabel,
                owner: code(),
                count,
                amountUsd: usd,
            }),
        ),
    }),
});
export type AgentOverview = z.infer<typeof agentOverviewSchema>;

/** A webhook endpoint. Never its secret. */
export const webhookEndpointSchema = z.object({
    id,
    // The API takes 2048 characters at most.
    url: z.string().max(MAX_URL_LENGTH),
    events: z.array(code()).max(MAX_WEBHOOK_EVENTS),
    enabled: z.boolean(),
    secretHint: plain,
    secretRotatedAt: date.nullable(),
    // Until when the secret before the last rotation still signs. Absent from an older API: null.
    previousSecretExpiresAt: date.nullable().default(null),
    failingSince: date.nullable(),
    disabledAt: date.nullable(),
    disabledError: text(MAX_EXCERPT_LENGTH).nullable(),
    createdAt: date,
    updatedAt: date,
});
export type WebhookEndpoint = z.infer<typeof webhookEndpointSchema>;

/** `GET /agent/webhooks`. */
export const webhookEndpointsSchema = z.array(webhookEndpointSchema);

/** `PATCH /agent/webhooks/:endpointId`: the endpoint, and the project it acted on. */
export const updatedWebhookSchema = webhookEndpointSchema.extend({ project: projectEcho });
export type UpdatedWebhook = z.infer<typeof updatedWebhookSchema>;

const webhookSecret = z.string().min(1).max(200);

/** `POST /agent/webhooks` and `POST .../secret/regenerate`: the endpoint and its secret in clear. */
export const webhookEndpointWithSecretSchema = webhookEndpointSchema.extend({
    secret: webhookSecret,
    // The project it acted on.
    project: projectEcho,
});
export type WebhookEndpointWithSecret = z.infer<typeof webhookEndpointWithSecretSchema>;

/** `GET /agent/webhooks/:endpointId/secret`. */
export const webhookSecretSchema = z.object({ secret: webhookSecret });

/** One delivery to an endpoint. Never the body posted. */
export const webhookDeliverySchema = z.object({
    id,
    eventId: id.nullable(),
    type: plain,
    test: z.boolean(),
    status: code(),
    attempts: count,
    inFlight: z.boolean(),
    lastResponseCode: z.number().nullable(),
    lastError: text(MAX_EXCERPT_LENGTH).nullable(),
    lastResponseExcerpt: text(MAX_EXCERPT_LENGTH).nullable(),
    nextAttemptAt: date.nullable(),
    deliveredAt: date.nullable(),
    createdAt: date,
    updatedAt: date,
});
export type WebhookDelivery = z.infer<typeof webhookDeliverySchema>;

/** `POST /agent/webhooks/:endpointId/test`: the delivery queued, and the project it acted on. */
export const testDeliverySchema = webhookDeliverySchema.extend({ project: projectEcho });
export type TestDelivery = z.infer<typeof testDeliverySchema>;

/** `GET /agent/webhooks/:endpointId/deliveries`. */
export const webhookDeliveryPageSchema = z.object({
    deliveries: z.array(webhookDeliverySchema),
    hasMore: z.boolean(),
});
export type WebhookDeliveryPage = z.infer<typeof webhookDeliveryPageSchema>;

/** `DELETE /agent/webhooks/:endpointId`: 204, with nothing in it. */
export const nothingSchema = z.undefined();
