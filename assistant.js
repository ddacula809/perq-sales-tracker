// assistant.js — Claude-powered "Ask Claude" assistant for the Revenue Desk.
//
// INACTIVE until configured: no-ops unless ANTHROPIC_API_KEY is set, so the app runs fine
// without it. To turn it on, set in Railway:
//   ANTHROPIC_API_KEY - your Anthropic API key (api.anthropic.com — separate from claude.ai)
//   ANTHROPIC_MODEL   - optional model id (default below)
//
// It calls the Anthropic Messages API directly via fetch (no npm dependency, keeps the flat,
// build-free repo simple) and gives Claude read-only TOOLS to look up app data on demand,
// rather than stuffing every row into the prompt. Tools are executed by the server (passed in),
// so this module stays storage-agnostic. The assistant cannot modify any data.

const API_KEY = process.env.ANTHROPIC_API_KEY || '';
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
const API_URL = 'https://api.anthropic.com/v1/messages';

export function assistantEnabled() { return !!API_KEY; }

// Read-only tools Claude may call. The server supplies the executors (see server.js).
const TOOLS = [
  {
    name: 'query_records',
    description:
      'Fetch matching rows from a Revenue Desk dataset. Use this to inspect specific records. '
      + 'Returns up to `limit` rows (default 100, max 500) plus the total number matched. '
      + 'Computed columns are included.',
    input_schema: {
      type: 'object',
      properties: {
        dataset: { type: 'string', enum: ['bookings', 'churn', 'sales_support', 'salesforce_recon'] },
        filters: {
          type: 'object',
          description: 'Optional exact-match (case-insensitive) filters keyed by column, e.g. {"pmc":"Harbor Group","booking_month":"May"}.',
          additionalProperties: true,
        },
        limit: { type: 'integer', description: 'Max rows to return (1–500).' },
      },
      required: ['dataset'],
    },
  },
  {
    name: 'summarize',
    description:
      'Count rows and sum numeric columns across a whole dataset (optionally filtered and grouped). '
      + 'Use this for totals/averages over many rows instead of pulling every record.',
    input_schema: {
      type: 'object',
      properties: {
        dataset: { type: 'string', enum: ['bookings', 'churn', 'sales_support', 'salesforce_recon'] },
        filters: { type: 'object', additionalProperties: true },
        sum_fields: { type: 'array', items: { type: 'string' }, description: 'Numeric column keys to total, e.g. ["mrr","company_total_booking"].' },
        group_by: { type: 'string', description: 'Optional column to group counts/sums by, e.g. "bpr_prod_category".' },
      },
      required: ['dataset'],
    },
  },
];

function systemPrompt(schemaText, user, today) {
  return [
    'You are the PERQ Revenue Desk assistant, embedded in an internal web app used by a sales-ops team.',
    'You answer questions and analyze the data in the app: bookings, churn, sales forecasting (sales_support),',
    'and the Salesforce recon reference (salesforce_recon).',
    '',
    `Today is ${today}. The current user is "${user.username}" (role: ${user.role}).`,
    '',
    'Guidelines:',
    '- Use the tools to look up data — never guess or invent figures. Prefer `summarize` for totals/counts',
    '  across many rows, and `query_records` to inspect specific records.',
    '- Money values are US dollars. Churn amounts are negative (a drop). Be precise and state the filters you used.',
    '- Keep answers concise and skimmable — short sentences, small bullet lists, or compact tables.',
    '- If the data does not contain something, say so plainly. You have read-only access and cannot change data.',
    '',
    'Datasets and their columns (key — Label):',
    schemaText,
  ].join('\n');
}

function textOf(content) {
  return (content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
}

async function callClaude(body) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 400);
    throw new Error(`Anthropic ${res.status}: ${detail}`);
  }
  return res.json();
}

// Run the assistant for a conversation. `messages` is the chat history ([{role,content}]).
// `tools` maps tool name -> async executor. Returns the assistant's text reply.
export async function runAssistant({ messages, user, schemaText, tools, today }) {
  if (!assistantEnabled()) throw new Error('Assistant not configured');
  const system = systemPrompt(schemaText, user, today);
  // Keep the last 24 turns to bound token use; ensure plain {role, content} shape.
  const convo = (messages || []).slice(-24).map((m) => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: typeof m.content === 'string' ? m.content : String(m.content ?? ''),
  }));

  for (let i = 0; i < 6; i++) { // cap tool round-trips
    const resp = await callClaude({ model: MODEL, max_tokens: 2048, system, tools: TOOLS, messages: convo });
    const blocks = resp.content || [];
    const toolUses = blocks.filter((b) => b.type === 'tool_use');
    convo.push({ role: 'assistant', content: blocks });
    if (resp.stop_reason !== 'tool_use' || !toolUses.length) {
      return textOf(blocks) || 'I could not produce a response.';
    }
    const results = [];
    for (const tu of toolUses) {
      let out;
      try {
        const fn = tools[tu.name];
        out = fn ? await fn(tu.input || {}) : { error: `Unknown tool: ${tu.name}` };
      } catch (e) {
        out = { error: e.message };
      }
      results.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: JSON.stringify(out).slice(0, 60000), // guard against oversized payloads
      });
    }
    convo.push({ role: 'user', content: results });
  }
  return 'That question needed too many lookups to finish — try narrowing it (e.g. a specific PMC, month, or quarter).';
}
