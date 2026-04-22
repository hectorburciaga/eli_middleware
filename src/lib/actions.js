import * as backend from './backendClient.js';

/**
 * Parses a Claude response for an <action> block and executes it.
 * Returns { display, actionResult } where display is the clean text
 * to show the user (action block stripped out).
 */
export async function executeAction(raw, interactionLang = 'en') {
  const actionMatch = raw.match(/<action>([\s\S]*?)<\/action>/);
  const display     = raw.replace(/<action>[\s\S]*?<\/action>/, '').trim();

  if (!actionMatch) return { display, actionResult: null };

  let actionResult = null;
  try {
    const action = JSON.parse(actionMatch[1]);

    if (action.type === 'create') {
      actionResult = await backend.createTask(action.task);
      const confirm = interactionLang === 'es' ? '✓ Tarea creada.' : '✓ Task created.';
      return { display: display + '\n\n' + confirm, actionResult };
    }

    if (action.type === 'update') {
      actionResult = await backend.updateTask(action.id, action.changes);
      const confirm = interactionLang === 'es' ? '✓ Tarea actualizada.' : '✓ Task updated.';
      return { display: display + '\n\n' + confirm, actionResult };
    }

    if (action.type === 'delete') {
      actionResult = await backend.deleteTask(action.id);
      const confirm = interactionLang === 'es' ? '✓ Tarea eliminada.' : '✓ Task deleted.';
      return { display: display + '\n\n' + confirm, actionResult };
    }

    console.warn('[action] Unknown action type:', action.type);
  } catch (err) {
    console.error('[action] Failed to execute action:', err.message);
    const errMsg = interactionLang === 'es'
      ? '\n\n⚠ No se pudo ejecutar la acción: ' + err.message
      : '\n\n⚠ Could not execute action: ' + err.message;
    return { display: display + errMsg, actionResult: null };
  }

  return { display, actionResult };
}
