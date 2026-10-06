const UNREADABLE = 'at a period this server cannot read';

/**
 * A plan's period as a person says it. A period is a number of hours and
 * never a calendar month: 720 hours is "every month", and the words say it is
 * 30 days. Anything else is counted in days or hours, as it is.
 */
export function periodInWords(hours: number): string {
    if (!Number.isFinite(hours) || hours <= 0) return UNREADABLE;
    if (hours === 1) return 'every hour';
    if (hours === 24) return 'every day';
    if (hours === 168) return 'every week';
    if (hours === 720) return 'every month (30 days)';
    if (hours === 8760) return 'every year (365 days)';
    if (Number.isInteger(hours) && hours % 24 === 0) return `every ${hours / 24} days`;
    return `every ${hours} hours`;
}
