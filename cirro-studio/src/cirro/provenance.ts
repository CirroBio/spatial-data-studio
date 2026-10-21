// Every entity the app creates carries the app tag and a provenance note: who made it,
// with which app version, from what, and how.
import { DiscussionType, type EntityType, type Tag } from '@cirrobio/api-client';
import { APP_ID, APP_NAME, APP_TAG, APP_VERSION } from '../app/appInfo';
import { describeError, type CirroSession } from './session';

export interface Provenance {
  what: string;
  why?: string;
  inputs: { name: string; id: string }[];
  parameters?: Record<string, unknown>;
}

export function withAppTag(extra: Tag[] = []): Tag[] {
  return [APP_TAG, ...extra.filter((t) => !(t.key === APP_TAG.key && t.value === APP_TAG.value))];
}

export function provenanceText(cirro: Pick<CirroSession, 'displayName' | 'username'>, p: Provenance): string {
  const user = cirro.displayName && cirro.displayName !== cirro.username ? `${cirro.displayName} (${cirro.username})` : cirro.username;
  const lines = [
    p.what,
    '',
    `Created by ${APP_NAME} ${APP_VERSION} (appId ${APP_ID}) for ${user} on ${new Date().toISOString()}.`,
  ];
  if (p.why) lines.push(`Why: ${p.why}`);
  if (p.inputs.length) lines.push('Inputs:', ...p.inputs.map((i) => `- ${i.name} (${i.id})`));
  if (p.parameters && Object.keys(p.parameters).length) lines.push('Parameters:', '```json', JSON.stringify(p.parameters, null, 2), '```');
  return lines.join('\n');
}

/** Null once the note is added, else what went wrong. The note follows the entity and
 * needs its own permission, so a failure is reported beside the result rather than as a
 * failed action, which a retry would then create a second time. */
export async function addProvenanceNote(
  cirro: CirroSession, projectId: string, entity: { type: EntityType; id: string }, p: Provenance,
): Promise<string | null> {
  try {
    const note = await cirro.data.feed.createDiscussion({
      discussionInput: { name: `Created by ${APP_NAME}`, description: `${APP_NAME} ${APP_VERSION}`, entity, type: DiscussionType.Notes, projectId },
    });
    await cirro.data.feed.postMessage({ discussionId: note.id, messageInput: { message: provenanceText(cirro, p) } });
    return null;
  } catch (e) {
    return `Cirro didn't add its provenance note: ${describeError(e, 'add notes')}`;
  }
}
