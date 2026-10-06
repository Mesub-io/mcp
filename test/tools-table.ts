import { groupOf, TOOLS, type AnyTool, type ToolGroup } from '../src/tools/index.js';

/** Where the table sits in the README: everything between the two is written by `pnpm readme:tools`. */
export const TABLE_START = '<!-- tools:start (written by `pnpm readme:tools`, do not edit) -->';
export const TABLE_END = '<!-- tools:end -->';

const GROUPS: [ToolGroup, string][] = [
    ['Read', 'They change nothing.'],
    ['Act', 'They change the project, or make Mesub call a server of the merchant.'],
    ['Prepare', 'It leaves the merchant something to review and sign, and publishes nothing.'],
];

/** What a client is told about a tool, and decides from whether to ask its user first. */
function hints({ annotations }: AnyTool): string {
    if (annotations.readOnlyHint) return 'Read-only';
    const told = [annotations.destructiveHint ? 'Changes, marked destructive' : 'Changes'];
    if (annotations.openWorldHint) told.push('reaches outside Mesub');
    return told.join(', ');
}

/** The tools of the registry, as the README lists them: by group, in the registry's order. */
export function toolsTable(tools: readonly AnyTool[] = TOOLS): string {
    const parts: string[] = [];
    for (const [group, what] of GROUPS) {
        const rows = tools.filter((tool) => groupOf(tool) === group);
        parts.push(
            `**${group}** (${rows.length}). ${what}`,
            '',
            '| Tool | What it does | What a client is told |',
            '| --- | --- | --- |',
            ...rows.map((tool) => `| \`${tool.name}\` | ${tool.title} | ${hints(tool)} |`),
            '',
        );
    }
    return parts.join('\n').trimEnd();
}
