// JSON schemas for structured LLM outputs. Kept strict (additionalProperties:false)
// so the engine can rely on the shape.

const str = { type: 'string' };
const strArr = { type: 'array', items: str };

export const WORLD_ADVANCE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['narration', 'phase', 'truth_updates', 'character_updates', 'new_events', 'cancel_event_keys', 'unresolved_situations'],
  properties: {
    narration: str,
    phase: { type: 'string', enum: ['pre_accident', 'accident', 'ambulance', 'er_waiting', 'exam', 'results', 'aftermath', 'settled'] },
    truth_updates: {
      type: 'object', additionalProperties: false,
      required: ['injury', 'diagnosis', 'mother_condition', 'notes'],
      properties: {
        injury: { type: 'string', description: 'Hidden truth about the injury. Empty string if unchanged/unknown yet.' },
        diagnosis: { type: 'string', description: 'What the medical staff will eventually conclude. Empty if not yet determined.' },
        mother_condition: { type: 'string', description: 'Current true condition (omniscient).' },
        notes: strArr,
      },
    },
    character_updates: {
      type: 'object', additionalProperties: false,
      required: ['sister', 'mother'],
      properties: {
        sister: {
          type: 'object', additionalProperties: false,
          required: ['location', 'activity', 'can_call'],
          properties: { location: str, activity: str, can_call: { type: 'boolean' } },
        },
        mother: {
          type: 'object', additionalProperties: false,
          required: ['location', 'status'],
          properties: { location: str, status: str },
        },
      },
    },
    new_events: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['key', 'type', 'offset_min', 'description', 'perception_sister', 'visible_to'],
        properties: {
          key: str,
          type: str,
          offset_min: { type: 'number' },
          description: { type: 'string', description: 'Omniscient description (never shown to characters).' },
          perception_sister: { type: 'string', description: 'What the sister perceives. Empty string if she is not present.' },
          visible_to: strArr,
        },
      },
    },
    cancel_event_keys: strArr,
    unresolved_situations: strArr,
  },
};

export const CHARACTER_DECISION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['inner_monologue', 'situation_assessment', 'emotional_state', 'stress', 'contact_decision', 'messages', 'actions', 'knowledge_updates', 'memory_entry', 'goals', 'intentions', 'next_check_in_min'],
  properties: {
    inner_monologue: str,
    situation_assessment: str,
    emotional_state: str,
    stress: { type: 'integer', minimum: 0, maximum: 100 },
    contact_decision: {
      type: 'object', additionalProperties: false,
      required: ['should_contact', 'reason', 'channel', 'urgency', 'consequence_if_not', 'already_told'],
      properties: {
        should_contact: { type: 'boolean' },
        reason: str,
        channel: { type: 'string', enum: ['none', 'text', 'call_wanted'] },
        urgency: { type: 'string', enum: ['none', 'low', 'medium', 'high'] },
        consequence_if_not: str,
        already_told: { type: 'boolean', description: 'true if the information was already conveyed earlier' },
      },
    },
    messages: {
      type: 'array',
      description: 'Text bubbles to send to the user, in order. Empty if not contacting.',
      items: {
        type: 'object', additionalProperties: false,
        required: ['text', 'pause_sec'],
        properties: { text: str, pause_sec: { type: 'number', minimum: 0, maximum: 60 } },
      },
    },
    actions: {
      type: 'array',
      description: 'Non-message actions in the world.',
      items: {
        type: 'object', additionalProperties: false,
        required: ['description', 'duration_min'],
        properties: { description: str, duration_min: { type: 'number', minimum: 0, maximum: 180 } },
      },
    },
    knowledge_updates: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['fact', 'source'],
        properties: { fact: str, source: str },
      },
    },
    memory_entry: str,
    goals: strArr,
    intentions: strArr,
    next_check_in_min: { type: 'number', minimum: 1, maximum: 180 },
  },
};
