// Property contracts pinned to Multica v0.6.2 cmd_property.go and issueproperty/value.go.
const multiTypes = new Set(['multi_text', 'multi_url', 'multi_select', 'multi_actor']);
const unique = (items) => [...new Set(items)];

function actorRef(value) {
  if (typeof value !== 'string' || !value.startsWith('member:')) throw new Error('value must be a member:<uuid> actor reference');
  let id = value.slice(7).trim().toLowerCase();
  if (id.startsWith('urn:uuid:')) id = id.slice(9);
  if (id.startsWith('{') && id.endsWith('}')) id = id.slice(1, -1);
  if (/^[0-9a-f]{32}$/.test(id)) id = `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) throw new Error('actor id must be a UUID');
  return `member:${id}`;
}

function textItem(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('value must be a non-empty string');
  if ([...value].length > 2000) throw new Error('value must be 2000 characters or fewer');
  return value.replace(/\0/g, '').replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD');
}

function urlItem(value) {
  if (typeof value !== 'string') throw new Error('value must be a URL string');
  const trimmed = value.trim();
  if (Buffer.byteLength(trimmed) > 2048) throw new Error('value must be 2048 characters or fewer');
  let url;
  try { url = new URL(trimmed); } catch { throw new Error('value must be an http(s) URL'); }
  if (!/^https?:\/\//.test(trimmed) || !url.hostname || /[\u0000-\u0020\u007f]/.test(trimmed) || /%(?![0-9a-f]{2})/i.test(trimmed)) throw new Error('value must be an http(s) URL');
  return trimmed;
}

function stringList(value, validate, noun = 'entries') {
  if (!Array.isArray(value) || !value.length) throw new Error('value must be a non-empty array of strings');
  if (value.length > 20) throw new Error(`value cannot list more than 20 ${noun}`);
  return unique(value.map(validate));
}

export function validateIssuePropertyValue(property, value) {
  if (property.archived) throw new Error(`property ${JSON.stringify(property.name)} is archived and cannot receive new values`);
  const options = property.config?.options ?? [];
  const optionID = (id) => {
    if (typeof id !== 'string' || !options.some((option) => option.id === id)) throw new Error('value must contain valid option ids');
    return id;
  };
  switch (property.type) {
    case 'text': return textItem(value);
    case 'multi_text': return stringList(value, textItem);
    case 'url': return urlItem(value);
    case 'multi_url': return stringList(value, urlItem);
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('value must be a finite number');
      return value;
    case 'checkbox':
      if (typeof value !== 'boolean') throw new Error('value must be true or false');
      return value;
    case 'date': {
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('value must be a date string in YYYY-MM-DD format');
      const [year, month, day] = value.split('-').map(Number);
      const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
      if (month < 1 || month > 12 || day < 1 || day > [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]) throw new Error('value must be a date string in YYYY-MM-DD format');
      return value;
    }
    case 'select': return optionID(value);
    case 'multi_select': {
      if (!Array.isArray(value) || !value.length) throw new Error('value must be a non-empty array of option ids');
      const ids = unique(value.map(optionID));
      return ids.sort((a, b) => options.findIndex((option) => option.id === a) - options.findIndex((option) => option.id === b));
    }
    case 'actor': return actorRef(value);
    case 'multi_actor': return stringList(value, actorRef, 'actors');
    default: throw new Error(`unsupported property type ${JSON.stringify(property.type)}`);
  }
}

export async function encodeIssuePropertyValue(property, raw, resolveMember) {
  if (property.archived) throw new Error(`property ${JSON.stringify(property.name)} is archived and cannot receive new values`);
  if (typeof raw !== 'string') throw new Error('--value is required');
  const parts = () => raw.split(',').map((item) => item.trim()).filter(Boolean);
  const option = (reference) => {
    const ref = reference.trim();
    const found = (property.config?.options ?? []).find((item) => item.id === ref || item.name.toLowerCase() === ref.toLowerCase());
    if (!found) throw new Error(`option ${JSON.stringify(ref)} not found on property ${JSON.stringify(property.name)}`);
    return found.id;
  };
  const member = async (reference) => {
    const ref = reference.trim();
    if (ref.startsWith('member:')) return actorRef(ref);
    if (!resolveMember) throw new Error('workspace member resolution is required');
    return actorRef(await resolveMember(ref));
  };
  let value = raw;
  switch (property.type) {
    case 'number':
      if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(raw)) throw new Error('value is not a valid JSON number');
      value = Number(raw); break;
    case 'checkbox':
      if (raw !== 'true' && raw !== 'false') throw new Error('value must be true or false');
      value = raw === 'true'; break;
    case 'select': value = option(raw); break;
    case 'multi_select': value = parts().map(option); break;
    case 'multi_text': case 'multi_url':
      try { value = raw.startsWith('[') ? JSON.parse(raw) : parts(); } catch { throw new Error('--value must be a JSON array of strings'); }
      break;
    case 'actor': value = await member(raw); break;
    case 'multi_actor': value = await Promise.all(parts().map(member)); break;
  }
  return validateIssuePropertyValue(property, value);
}

const formatValue = (value) => typeof value === 'string' ? value : JSON.stringify(value);

export function issuePropertyNeedsMembers(properties, bag) {
  return properties.some((property) => ['actor', 'multi_actor'].includes(property.type) && Object.hasOwn(bag, property.id));
}

export function buildIssuePropertyRows(properties, bag, actorNames = {}) {
  return properties.filter((property) => Object.hasOwn(bag, property.id)).map((property) => {
    const value = bag[property.id];
    const displayItem = (item) => {
      if (typeof item !== 'string') return formatValue(item);
      if (['select', 'multi_select'].includes(property.type)) return (property.config?.options ?? []).find((option) => option.id === item)?.name ?? item;
      if (['actor', 'multi_actor'].includes(property.type)) return actorNames[item] ?? item;
      return item;
    };
    const displays = multiTypes.has(property.type) && Array.isArray(value) ? value.map(displayItem) : undefined;
    // Checkbox glyphs match the upstream JSON display field, not just its table UI.
    const display = displays ? displays.join(', ') : property.type === 'checkbox' && typeof value === 'boolean' ? (value ? '\u2713' : '\u2717') : displayItem(value);
    return { property_id: property.id, name: property.name, type: property.type, value, display,
      ...(displays?.length ? { display_values: displays } : {}), ...(property.archived ? { archived: true } : {}) };
  });
}
