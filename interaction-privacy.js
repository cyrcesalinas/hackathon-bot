import { InteractionType } from 'discord-interactions';
import { AGENT_UI_PREFIX, AGENT_UI_MODAL_PREFIX } from './agent-ui.js';

export function keepsInteractionPrivate({ type, data }) {
  return (type === InteractionType.APPLICATION_COMMAND && ['agent', 'memory'].includes(data?.name))
    || (type === InteractionType.MESSAGE_COMPONENT && data?.custom_id?.startsWith(AGENT_UI_PREFIX))
    || (type === InteractionType.MODAL_SUBMIT && data?.custom_id?.startsWith(AGENT_UI_MODAL_PREFIX));
}
