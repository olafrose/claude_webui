// Converts SDK stream messages and stored transcript messages into flat UI "entries".
//
// Entry kinds:
//   user        { text, images }
//   text        { text }                      assistant prose
//   thinking    { text }
//   tool_use    { toolUseId, name, input }
//   tool_result { toolUseId, text, isError }
//   system      { text, level }
// Every entry carries: id, parent (parent_tool_use_id or null), ts.

const MAX_TEXT = 12_000;
const MAX_INPUT_FIELD = 6_000;

function clip(s, max = MAX_TEXT) {
  if (typeof s !== 'string') return s;
  return s.length > max ? `${s.slice(0, max)}\n… [${s.length - max} more chars]` : s;
}

function clipInput(input) {
  if (!input || typeof input !== 'object') return input;
  const out = Array.isArray(input) ? [] : {};
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === 'string') out[k] = clip(v, MAX_INPUT_FIELD);
    else if (v && typeof v === 'object' && JSON.stringify(v).length > MAX_INPUT_FIELD) out[k] = clipInput(v);
    else out[k] = v;
  }
  return out;
}

function stripNoise(text) {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, '')
    .trim();
}

/** Render user-side slash command wrappers (e.g. "<command-name>/compact</command-name>") into readable text. */
function commandText(text) {
  const name = text.match(/<command-name>([\s\S]*?)<\/command-name>/)?.[1];
  if (name) {
    const args = text.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1] || '';
    return `${name.trim()} ${args.trim()}`.trim();
  }
  const out = text.match(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/)?.[1];
  if (out !== undefined) return null; // command output echo; shown elsewhere
  return text;
}

function toolResultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => (b.type === 'text' ? b.text : b.type === 'image' ? '[image]' : b.type === 'tool_reference' ? `[${b.tool_name}]` : ''))
    .filter(Boolean)
    .join('\n');
}

/**
 * @param {{type:string, uuid?:string, message?:any, parent_tool_use_id?:string|null, timestamp?:string, isSynthetic?:boolean}} msg
 * @returns {object[]}
 */
export function normalizeMessage(msg) {
  const out = [];
  if (msg.type !== 'user' && msg.type !== 'assistant') return out;
  const m = msg.message || {};
  const parent = msg.parent_tool_use_id || null;
  const ts = msg.timestamp ? Date.parse(msg.timestamp) : Date.now();
  const base = (i) => ({ id: `${msg.uuid || m.id || Math.random().toString(36).slice(2)}:${i}`, parent, ts });
  const content = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : Array.isArray(m.content) ? m.content : [];

  if (msg.type === 'assistant') {
    content.forEach((b, i) => {
      if (b.type === 'text' && b.text?.trim()) out.push({ ...base(i), kind: 'text', text: clip(b.text) });
      else if (b.type === 'thinking' && b.thinking?.trim()) out.push({ ...base(i), kind: 'thinking', text: clip(b.thinking) });
      else if (b.type === 'tool_use' || b.type === 'server_tool_use' || b.type === 'mcp_tool_use')
        out.push({ ...base(i), kind: 'tool_use', toolUseId: b.id, name: b.name, input: clipInput(b.input) });
    });
    if (msg.error && !out.length) out.push({ ...base(0), kind: 'system', level: 'error', text: `API error: ${msg.error}` });
    return out;
  }

  // user
  const texts = [];
  const images = [];
  content.forEach((b, i) => {
    if (b.type === 'tool_result') {
      out.push({ ...base(i), kind: 'tool_result', toolUseId: b.tool_use_id, text: clip(toolResultText(b.content)), isError: !!b.is_error });
    } else if (b.type === 'text' && !msg.isSynthetic) {
      const t = commandText(stripNoise(b.text || ''));
      if (t) texts.push(t);
    } else if (b.type === 'image' && b.source?.type === 'base64') {
      images.push(`data:${b.source.media_type};base64,${b.source.data}`);
    }
  });
  // Subagent prompts are shown in the agent panel, not as user bubbles.
  if ((texts.length || images.length) && !parent) {
    out.unshift({ ...base('u'), kind: 'user', text: clip(texts.join('\n\n')), images });
  } else if (texts.length && parent) {
    out.unshift({ ...base('u'), kind: 'prompt', text: clip(texts.join('\n\n')) });
  }
  return out;
}

export function normalizeMessages(msgs) {
  return msgs.flatMap(normalizeMessage);
}
