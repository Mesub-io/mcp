import { reachOf } from '../src/tools/list-events.js';

const NOW = Date.parse('2026-10-16T12:00:00Z');

describe('how much of a range the event log still holds', () => {
    it('holds a day within the 45 days', () => {
        expect(reachOf('2026-10-01', undefined, NOW)).toBe('all');
        expect(reachOf('2026-09-02', undefined, NOW)).toBe('all');
    });

    it('holds none of a day that ended before them', () => {
        expect(reachOf('2026-08-31', undefined, NOW)).toBe('none');
        expect(reachOf('2020-01-01', undefined, NOW)).toBe('none');
    });

    it('holds part of a day, a week or a month that straddles the purge', () => {
        expect(reachOf('2026-09-01', undefined, NOW)).toBe('part');
        expect(reachOf('2026-08-28', 'week', NOW)).toBe('part');
        expect(reachOf('2026-08-01', 'month', NOW)).toBe('none');
        expect(reachOf('2026-09-01', 'month', NOW)).toBe('part');
    });
});
