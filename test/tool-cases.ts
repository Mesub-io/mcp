import * as answers from './fixtures/agent-answers.js';
import {
    DELIVERY_ID,
    PLAN_ID,
    USDC,
    SUBSCRIPTION_ID,
    WALLET,
    WEBHOOK_ID,
} from './fixtures/agent-answers.js';

/** One tool, called with arguments it takes, and the one call to the API that must come of it. */
export interface ToolCase {
    tool: string;
    args: Record<string, unknown>;
    method: string;
    pathname: string;
    /** As the API reads it: every value a string. */
    query: Record<string, string>;
    /** Undefined: no body at all. */
    body: unknown;
    /** What the API answers when all is well. */
    status: number;
    answer: unknown;
}

export const HOOK_URL = 'https://hooks.example.test/mesub';

export const CASES: ToolCase[] = [
    {
        tool: 'get_project',
        args: {},
        method: 'GET',
        pathname: '/agent/project',
        query: {},
        body: undefined,
        status: 200,
        answer: answers.project,
    },
    {
        tool: 'list_plans',
        args: {},
        method: 'GET',
        pathname: '/agent/plans',
        query: {},
        body: undefined,
        status: 200,
        answer: answers.plans,
    },
    {
        tool: 'get_plan',
        args: { plan_id: PLAN_ID },
        method: 'GET',
        pathname: `/agent/plans/${PLAN_ID}`,
        query: {},
        body: undefined,
        status: 200,
        answer: answers.planDetail,
    },
    {
        tool: 'list_subscriptions',
        args: { plan_id: PLAN_ID, status: 'late', q: '7xKX', days: 7, page: 2, limit: 20 },
        method: 'GET',
        pathname: '/agent/subscriptions',
        query: { plan: PLAN_ID, status: 'late', q: '7xKX', days: '7', page: '2', limit: '20' },
        body: undefined,
        status: 200,
        answer: { ...answers.subscriptionPage, page: 2 },
    },
    {
        tool: 'get_subscription',
        args: { subscription_id: SUBSCRIPTION_ID },
        method: 'GET',
        pathname: `/agent/subscriptions/${SUBSCRIPTION_ID}`,
        query: {},
        body: undefined,
        status: 200,
        answer: answers.subscription,
    },
    {
        tool: 'check_access',
        args: { wallet: WALLET, plan: 'pro', attempts: true },
        method: 'GET',
        pathname: '/agent/access',
        query: { wallet: WALLET, plan: 'pro', attempts: 'true' },
        body: undefined,
        status: 200,
        answer: answers.accessAnswer,
    },
    {
        tool: 'list_events',
        args: { day: '2026-10-01', plan_id: PLAN_ID, group: 'payments', q: '7xKX', by: 'week' },
        method: 'GET',
        pathname: '/agent/events',
        query: { day: '2026-10-01', plan: PLAN_ID, group: 'payments', q: '7xKX', by: 'week' },
        body: undefined,
        status: 200,
        answer: answers.eventLines,
    },
    {
        tool: 'list_upcoming_charges',
        args: { plan_id: PLAN_ID, days: 7, group: 'payments', q: '7xKX' },
        method: 'GET',
        pathname: '/agent/events/upcoming',
        query: { plan: PLAN_ID, days: '7', group: 'payments', q: '7xKX' },
        body: undefined,
        status: 200,
        answer: answers.upcoming,
    },
    {
        tool: 'get_overview',
        args: { plan_id: PLAN_ID, days: 7 },
        method: 'GET',
        pathname: '/agent/overview',
        query: { plan: PLAN_ID, days: '7' },
        body: undefined,
        status: 200,
        answer: answers.overview,
    },
    {
        tool: 'list_webhooks',
        args: {},
        method: 'GET',
        pathname: '/agent/webhooks',
        query: {},
        body: undefined,
        status: 200,
        answer: answers.webhooks,
    },
    {
        tool: 'list_webhook_deliveries',
        args: { webhook_id: WEBHOOK_ID, limit: 2, starting_after: DELIVERY_ID },
        method: 'GET',
        pathname: `/agent/webhooks/${WEBHOOK_ID}/deliveries`,
        query: { limit: '2', startingAfter: DELIVERY_ID },
        body: undefined,
        status: 200,
        answer: answers.deliveryPage,
    },
    {
        tool: 'update_project',
        args: { name: 'Fraise & Co' },
        method: 'PATCH',
        pathname: '/agent/project',
        query: {},
        body: { name: 'Fraise & Co' },
        status: 200,
        answer: answers.servedProject,
    },
    {
        tool: 'update_retry_policy',
        args: { plan_id: PLAN_ID, retry_attempts: 3, retry_delay_minutes: 60 },
        method: 'PATCH',
        pathname: `/agent/plans/${PLAN_ID}/retry-policy`,
        query: {},
        body: { retryAttempts: 3, retryDelayMinutes: 60 },
        status: 200,
        answer: answers.plan,
    },
    {
        tool: 'retry_charge',
        args: { subscription_id: SUBSCRIPTION_ID },
        method: 'POST',
        pathname: `/agent/subscriptions/${SUBSCRIPTION_ID}/retry`,
        query: {},
        body: undefined,
        status: 202,
        answer: answers.subscription,
    },
    {
        tool: 'create_webhook',
        args: { url: HOOK_URL, events: ['subscription.created'], enabled: false },
        method: 'POST',
        pathname: '/agent/webhooks',
        query: {},
        body: { url: HOOK_URL, events: ['subscription.created'], enabled: false },
        status: 201,
        answer: answers.webhookWithSecret,
    },
    {
        tool: 'update_webhook',
        args: { webhook_id: WEBHOOK_ID, enabled: false },
        method: 'PATCH',
        pathname: `/agent/webhooks/${WEBHOOK_ID}`,
        query: {},
        body: { enabled: false },
        status: 200,
        answer: answers.webhook,
    },
    {
        tool: 'delete_webhook',
        args: { webhook_id: WEBHOOK_ID },
        method: 'DELETE',
        pathname: `/agent/webhooks/${WEBHOOK_ID}`,
        query: {},
        body: undefined,
        status: 204,
        answer: '',
    },
    {
        tool: 'get_webhook_secret',
        args: { webhook_id: WEBHOOK_ID },
        method: 'GET',
        pathname: `/agent/webhooks/${WEBHOOK_ID}/secret`,
        query: {},
        body: undefined,
        status: 200,
        answer: { secret: answers.SECRET_VALUE },
    },
    {
        tool: 'regenerate_webhook_secret',
        args: { webhook_id: WEBHOOK_ID },
        method: 'POST',
        pathname: `/agent/webhooks/${WEBHOOK_ID}/secret/regenerate`,
        query: {},
        body: undefined,
        status: 201,
        answer: answers.webhookWithSecret,
    },
    {
        tool: 'send_test_webhook',
        args: { webhook_id: WEBHOOK_ID, event: 'subscription.created' },
        method: 'POST',
        pathname: `/agent/webhooks/${WEBHOOK_ID}/test`,
        query: {},
        body: { event: 'subscription.created' },
        status: 202,
        answer: answers.testDelivery,
    },
    {
        tool: 'prepare_plan',
        args: {
            name: 'Pro',
            token: 'USDC',
            price: '9.99',
            period_hours: 720,
            description: 'Everything.',
            website_url: 'https://fraise.example.test/pro',
            retry_attempts: 3,
            retry_delay_minutes: 60,
        },
        method: 'POST',
        pathname: '/agent/plans',
        query: {},
        body: {
            name: 'Pro',
            mint: USDC,
            amount: '9990000',
            periodHours: 720,
            description: 'Everything.',
            websiteUrl: 'https://fraise.example.test/pro',
            retryAttempts: 3,
            retryDelayMinutes: 60,
        },
        status: 201,
        answer: answers.preparedPlan,
    },
];

export const caseOf = (tool: string): ToolCase => {
    const found = CASES.find((entry) => entry.tool === tool);
    if (!found) throw new Error(`No case for ${tool}.`);
    return found;
};

/** The four hints of every tool, as they are meant. `true` is the answer that makes a client ask. */
export const ANNOTATIONS: Record<string, [boolean, boolean, boolean, boolean]> = {
    //                          readOnly destructive idempotent openWorld
    ping: [true, false, true, false],
    search_docs: [true, false, true, false],
    get_project: [true, false, true, false],
    list_plans: [true, false, true, false],
    get_plan: [true, false, true, false],
    list_subscriptions: [true, false, true, false],
    get_subscription: [true, false, true, false],
    check_access: [true, false, true, false],
    list_events: [true, false, true, false],
    list_upcoming_charges: [true, false, true, false],
    get_overview: [true, false, true, false],
    list_webhooks: [true, false, true, false],
    list_webhook_deliveries: [true, false, true, false],
    update_project: [false, true, true, false],
    update_retry_policy: [false, true, true, false],
    retry_charge: [false, true, false, true],
    create_webhook: [false, false, false, true],
    update_webhook: [false, true, true, true],
    delete_webhook: [false, true, true, false],
    get_webhook_secret: [true, false, true, false],
    regenerate_webhook_secret: [false, true, false, false],
    send_test_webhook: [false, false, false, true],
    // It creates a draft inside Mesub and nothing else: not destructive, not on chain.
    prepare_plan: [false, false, false, false],
};
