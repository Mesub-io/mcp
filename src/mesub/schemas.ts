import * as z from 'zod';

import { clip } from '../text.js';
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
    project: z.object({ id: z.string().min(1).max(200), name: z.string().max(500) }),
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

// The routes under /agent that read and change the connection's project. An
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
] as const;

/** How long a text somebody else wrote may be before it is cut. */
export const MAX_NAME_LENGTH = 200;
export const MAX_DESCRIPTION_LENGTH = 1000;
export const MAX_REASON_LENGTH = 300;
export const MAX_EXCERPT_LENGTH = 500;
export const MAX_DETAIL_LENGTH = 1000;
/** Past any list of events an endpoint takes, whatever the API adds. */
export const MAX_WEBHOOK_EVENTS = 64;
/** An address is kept whole or refused: one cut short is another address. */
export const MAX_URL_LENGTH = 2048;

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

/** `PATCH /agent/project`. */
export const renamedProjectSchema = servedProjectSchema;
export type ServedProject = z.infer<typeof servedProjectSchema>;

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
    symbol: z.string().max(20).nullable(),
    decimals,
    periodHours: z.number(),
    endsAt: date.nullable(),
    retryAttempts: count.nullable(),
    retryDelayMinutes: count.nullable(),
    retryPolicy: z.object({ honoured: z.boolean(), reason: text(MAX_REASON_LENGTH).nullable() }),
    receiver: plain,
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

/** `POST /agent/plans`: the plan just prepared, and where its merchant signs it. */
export const preparedPlanSchema = agentPlanSchema.extend({
    signUrl: link,
    nextStep: text(MAX_REASON_LENGTH),
});
export type PreparedPlan = z.infer<typeof preparedPlanSchema>;

/** `GET /agent/plans`. */
export const agentPlansSchema = z.array(
    agentPlanSchema.extend({
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
    plan: agentPlanSchema,
    subscribers: countsByCode(),
    monthly: amount,
    monthlyUsd: usd.nullable(),
    collected: amount,
    collectedUsd: usd,
    unpricedPaid: count,
    outcomes: countsByCode(),
    failures: z.array(z.object({ reason: text(MAX_REASON_LENGTH), reasonLabel, count })),
    upcoming: z.array(
        z.object({ subscriber: plain, dueAt: date, failedPulls: count, retries: count }),
    ),
    nextPull: z.object({ dueAt: date, amount, manual: z.boolean() }).nullable(),
    attempts: z.array(attemptSchema.extend({ subscriptionId: id })),
});
export type AgentPlanDetail = z.infer<typeof agentPlanDetailSchema>;

const subscriptionRowSchema = z.object({
    id,
    subscriber: plain,
    planId: id,
    planName: text(MAX_NAME_LENGTH).nullable(),
    status: subscriptionStatus,
    // CANCELLED, PLAN_REMOVED, PLAN_REPLACED, PLAN_ENDED, AUTHORITY_CLOSED or CLOSED.
    endReason: code().nullable(),
    // INSUFFICIENT_BALANCE, APPROVAL_REVOKED or AUTHORITY_CLOSED.
    lateReason: code().nullable(),
    hasAccess: z.boolean(),
    accessUntil: date.nullable(),
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

/** One answer of `GET /agent/access`: the public `/v1/access` contract, snake_case. */
const accessAnswerSchema = z.object({
    wallet: plain.nullable(),
    plan: plain,
    access: z.boolean(),
    status: code(),
    paused: z.boolean(),
    end_reason: code().nullable(),
    late_reason: code().nullable(),
    payment_status: code(),
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
    days: z.array(z.object({ day: plain, pulledUsd: usd, failedUsd: usd })),
    page: count,
    hasMore: z.boolean(),
});
export type AgentEventDays = z.infer<typeof agentEventDaysSchema>;

/** `GET /agent/events?day=`: that day in full. */
export const agentEventLinesSchema = z.array(
    z.object({
        id,
        source: code(),
        // An outcome or an event type: a name in capitals, whichever it is.
        type: code(),
        occurredAt: date,
        subscriptionId: id.nullable(),
        subscriber: plain.nullable(),
        planId: id.nullable(),
        planName: text(MAX_NAME_LENGTH).nullable(),
        amount: amount.nullable(),
        amountUsd: usd.nullable(),
        mint: plain.nullable(),
        symbol,
        decimals,
        reason: text(MAX_REASON_LENGTH).nullable(),
        reasonLabel,
        retry: z.boolean(),
        signature: plain.nullable(),
        // A small JSON object: kept as the text of its JSON, cut short.
        detail: z
            .unknown()
            .transform((value) =>
                value === null || value === undefined
                    ? null
                    : clip(JSON.stringify(value), MAX_DETAIL_LENGTH),
            ),
    }),
);
export type AgentEventLine = z.infer<typeof agentEventLinesSchema>[number];

/** `GET /agent/events/upcoming`. */
export const agentUpcomingSchema = z.array(
    z.object({
        subscriptionId: id,
        subscriber: plain,
        planId: id,
        planName: text(MAX_NAME_LENGTH).nullable(),
        kind: code(),
        at: date,
        retry: count,
        retriesAllowed: count,
        amount: amount.nullable(),
        mint: plain,
        symbol,
        decimals,
        amountUsd: usd.nullable(),
        renewalIssue: code().nullable(),
        renewalCheckedAt: date.nullable(),
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
                subscriptionId: id,
                planId: id,
                planName: text(MAX_NAME_LENGTH).nullable(),
                subscriber: plain,
                dueAt: date,
                failedPulls: count,
                retriesAllowed: count,
                amount,
                mint: plain,
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
    failingSince: date.nullable(),
    disabledAt: date.nullable(),
    disabledError: text(MAX_EXCERPT_LENGTH).nullable(),
    createdAt: date,
    updatedAt: date,
});
export type WebhookEndpoint = z.infer<typeof webhookEndpointSchema>;

/** `GET /agent/webhooks`. */
export const webhookEndpointsSchema = z.array(webhookEndpointSchema);

const webhookSecret = z.string().min(1).max(200);

/** `POST /agent/webhooks` and `POST .../secret/regenerate`: the endpoint and its secret in clear. */
export const webhookEndpointWithSecretSchema = webhookEndpointSchema.extend({
    secret: webhookSecret,
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

/** `GET /agent/webhooks/:endpointId/deliveries`. */
export const webhookDeliveryPageSchema = z.object({
    deliveries: z.array(webhookDeliverySchema),
    hasMore: z.boolean(),
});
export type WebhookDeliveryPage = z.infer<typeof webhookDeliveryPageSchema>;

/** `DELETE /agent/webhooks/:endpointId`: 204, with nothing in it. */
export const nothingSchema = z.undefined();
