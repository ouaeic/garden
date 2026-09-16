import { randomBytes, randomUUID } from 'node:crypto';
import { publishesPublicly } from '@athanor/contracts';
import { encryptJson, sha256, AthanorError } from '@athanor/core';
import { type ModelToolCall } from '@athanor/model-gateway';
import { type ExecObservation } from '../agent-state.js';
import { event } from '../tool-recording.js';
import { previewUrl, textValue } from '../values.js';
import { type ToolContext } from '../tool-dispatch.js';
import { clampNumber, finiteNumber } from './numbers.js';

/**
 * The port the agent named, or a refusal - and the refusal comes from the parse, not from the
 * comparison.
 *
 * Both publishing arms wrote `Math.max(1024, Math.min(65_535, Number(call.arguments.port)))` -
 * they were two arms then, and this is the reader the one arm below now uses for either reach -
 * which answers `NaN` for anything the model spelled wrong. Two things then happened that a wrong
 * port would not have caused. The scope handed to the runner is minted from this value, so the
 * capability token said `preview:NaN` and the check went to `/preview-check/NaN`. And the refusal
 * of 4300 - the port the workspace runtime keeps for itself - is a `===`, which is false against
 * `NaN` like every other comparison: the one port this computer will not publish was reachable by
 * asking for it in a way the clamp could not read. A fractional port lands in the same place, so
 * the value is cut to a whole number before the reserved port is looked for rather than after.
 *
 * Refused rather than defaulted because `port` is a required parameter with nowhere to fall back
 * to: quietly publishing 1024 instead would hand the owner a link to something they never asked
 * about. The range clamp stays for a readable but out-of-range number, which is what it always did.
 */
const previewPort = (value: unknown): number => {
  const named = finiteNumber(value);
  if (named === null)
    throw new AthanorError(
      'preview_port_invalid',
      'A port is a whole number between 1024 and 65535. Name the port the app is actually listening on.'
    );
  const port = clampNumber(named, { min: 1024, max: 65_535, fallback: 1024, integer: true });
  if (port === 4300)
    throw new AthanorError(
      'preview_port_reserved',
      'Port 4300 is reserved by the workspace runtime'
    );
  return port;
};

/**
 * The publishing tools: the two ways bytes leave this computer for a URL someone else can open.
 *
 * Together because they are the group the approval floor cares most about, and because both mint
 * the same kind of token and hand back the same kind of address - the differences between them are
 * lifetime and audience, which is exactly what a reader comparing them needs to see at once.
 *
 * It was three tools until `publish_site` became `publish_preview`'s `reach: 'public'`. What it did
 * is all still here, in the one arm below; what is gone is a second NAME for it, which is what the
 * approval floor used to have to read in order to guess how far a call reached.
 */
export async function executePublishingTool(
  context: ToolContext,
  call: ModelToolCall
): Promise<unknown> {
  const { task, key } = context;
  const root = `/v1/workspaces/${task.workspaceId}`;
  switch (call.name) {
    case 'publish_artifact': {
      const sourcePath = textValue(call.arguments.path);
      const name = textValue(call.arguments.name, sourcePath.split('/').at(-1) ?? 'artifact');
      const requestedMime = textValue(call.arguments.mimeType);
      const source = await context.runner.readBytes(task.workspaceId, task.id, sourcePath);
      /*
       * A type the agent asked for is a type an injected instruction may have asked for.
       *
       * The reader's job is to be sceptical of what it reads, and this string ends up deciding
       * how a browser treats the bytes. `text/html` or an SVG here is a script on the owner's own
       * origin the moment they open what the agent saved. The serving route refuses to render
       * anything outside its own allowlist anyway, so this is the second lock rather than the
       * only one - but a hostile value should not be sitting in the database waiting for a future
       * reader that trusts it.
       */
      const scriptableMime = /^(?:text\/html|application\/xhtml)|(?:\+xml)$|^image\/svg/i.test(
        requestedMime
      );
      const mimeType = (!scriptableMime && requestedMime) || source.mimeType;
      const storageKey = `.athanor/artifacts/${randomUUID()}`;
      await context.runner.writeBytes(task.workspaceId, task.id, storageKey, source.bytes);
      const artifact = await context.store.createArtifact({
        userId: task.userId,
        workspaceId: task.workspaceId,
        taskId: task.id,
        logicalKey: sha256(sourcePath),
        nameCiphertext: encryptJson({ name }, key, `artifact-name:${task.workspaceId}`),
        mimeType,
        sizeBytes: source.bytes.byteLength,
        sha256: sha256(source.bytes),
        storageKey
      });
      let preview:
        | {
            artifactId: string;
            name: string;
            mimeType: string;
            sizeBytes: number;
            version: number;
          }
        | undefined;
      const extension = sourcePath.split('.').at(-1)?.toLowerCase() ?? '';
      if (['pptx', 'docx', 'xlsx', 'odp', 'odt', 'ods'].includes(extension)) {
        const previewPath = `workspace/.athanor/renders/${randomUUID()}.pdf`;
        try {
          // The same wrapper every vetted procedure names, rather than bare LibreOffice. It
          // writes the file where it is told instead of choosing a name from the input stem, it
          // runs on a throwaway profile so a concurrent conversion started by a skill cannot
          // corrupt this one, and it exits non-zero when the bytes are not there - which
          // LibreOffice does not, and which is exactly how a review copy used to come back as a
          // missing file rather than as a conversion failure.
          const rendered = await context.runner.call<ExecObservation>(
            task.workspaceId,
            task.id,
            'exec',
            `${root}/exec`,
            {
              executable: 'athanor-office-convert',
              args: [sourcePath, previewPath],
              cwd: '.',
              timeoutSeconds: 200
            }
          );
          if (rendered.exitCode !== 0)
            throw new Error(rendered.stderr || 'Office conversion failed');
          const previewSource = await context.runner.readBytes(
            task.workspaceId,
            task.id,
            previewPath
          );
          const previewStorageKey = `.athanor/artifacts/${randomUUID()}`;
          await context.runner.writeBytes(
            task.workspaceId,
            task.id,
            previewStorageKey,
            previewSource.bytes
          );
          const previewName = name.replace(/\.[^.]+$/, '') + '.pdf';
          const previewArtifact = await context.store.createArtifact({
            userId: task.userId,
            workspaceId: task.workspaceId,
            taskId: task.id,
            logicalKey: sha256(`${sourcePath}:rendered-pdf`),
            nameCiphertext: encryptJson(
              { name: previewName },
              key,
              `artifact-name:${task.workspaceId}`
            ),
            mimeType: 'application/pdf',
            sizeBytes: previewSource.bytes.byteLength,
            sha256: sha256(previewSource.bytes),
            storageKey: previewStorageKey
          });
          preview = {
            artifactId: String(previewArtifact.id),
            name: previewName,
            mimeType: 'application/pdf',
            sizeBytes: previewSource.bytes.byteLength,
            version: Number(previewArtifact.version)
          };
        } catch (cause) {
          await event(
            context.store,
            task,
            key,
            'warning',
            'Editable file saved, but its review PDF could not be rendered',
            { message: cause instanceof Error ? cause.message : 'Document render failed' }
          );
        }
      }
      const usage = await context.runner.call<{ storageBytes: number }>(
        task.workspaceId,
        task.id,
        'files.read',
        `${root}/usage`
      );
      await context.store.setWorkspaceStorage(task.userId, task.workspaceId, usage.storageBytes);
      return {
        artifactId: artifact.id,
        name,
        mimeType,
        sizeBytes: source.bytes.byteLength,
        version: Number(artifact.version),
        ...(preview ? { preview } : {})
      };
    }
    /*
     * ONE arm for both reaches, where there were two cases differing in about a dozen lines.
     *
     * `publish_site` was folded in here as the `reach` argument and its catalogue entry deleted.
     * The two arms already did the same work - clamp the port, check something is listening, mint a
     * token, create the preview row - and the public one then called `publishWorkspacePreview` on
     * top. What made keeping them apart actively dangerous rather than merely repetitive is that
     * the approval floor read the TOOL NAME to decide how far the call reached, so the two names
     * were the only thing standing between a private link and a public deployment.
     *
     * `publishesPublicly` is that decision, and it is imported rather than re-spelled here: the
     * floor calls the same function on the same argument, so the arm cannot publish publicly on a
     * call the floor judged private. A `reach` neither of them recognises is private for both.
     */
    case 'publish_preview': {
      const publicReach = publishesPublicly(call.arguments.reach);
      const port = previewPort(call.arguments.port);
      const label = textValue(call.arguments.label, publicReach ? 'Published app' : 'App preview')
        .trim()
        .slice(0, 80);
      const check = await context.runner.call<{ available: boolean }>(
        task.workspaceId,
        task.id,
        `preview:${port}`,
        `${root}/preview-check/${port}`
      );
      if (!check.available)
        throw new AthanorError(
          'preview_port_unavailable',
          `No service is listening on port ${port} of this computer. Bind the app to 127.0.0.1 and try again.`
        );
      const accessToken = randomBytes(32).toString('base64url');
      const slug = randomBytes(16).toString('hex');
      /*
       * Refused rather than cleaned up. The only thing a scheme, a host or a `..` could be doing
       * here is pointing the owner's link somewhere the preview is not.
       */
      const entryPath = textValue(call.arguments.path).trim().replace(/^\/+/, '').slice(0, 300);
      if (
        entryPath &&
        (/^[a-z][a-z0-9+.-]*:/i.test(entryPath) ||
          entryPath.startsWith('//') ||
          entryPath.split(/[/\\]/).includes('..'))
      )
        throw new AthanorError(
          'preview_path_invalid',
          'A preview path is a path inside the served port, not a URL, and it may not climb out of it'
        );
      const created = await context.store.createWorkspacePreview({
        userId: task.userId,
        workspaceId: task.workspaceId,
        label,
        port,
        slug,
        accessTokenHash: sha256(accessToken),
        entryPath: entryPath || null
      });
      if (!publicReach) {
        const preview = {
          previewId: created.id,
          label,
          port,
          url: previewUrl(context.config.PREVIEW_BASE_URL, slug, accessToken, entryPath),
          visibility: 'private',
          expiresAt: created.expiresAt
        };
        await event(context.store, task, key, 'preview', `${label} is ready`, preview);
        return preview;
      }
      // Published on demand, which is the store's own default and the only mode with behaviour
      // behind it: the preview gateway wakes a hibernated computer for an on-demand site, and
      // nothing anywhere holds one awake. The agent is not offered a choice between a mode that
      // works and a mode that only reads as if it did.
      const published = await context.store.publishWorkspacePreview(
        task.userId,
        created.id,
        'public',
        sha256(accessToken)
      );
      if (!published)
        throw new AthanorError('preview_publish_failed', 'Public deployment could not be saved');
      const deployment = {
        previewId: published.id,
        label,
        port,
        /*
         * No access token, and the entry path kept.
         *
         * The token is what makes a private link private; a public URL carrying one would hand
         * every visitor the bearer credential for the same preview, so it is dropped here and the
         * API drops it too (`preview.visibility === 'private'` guards it in apps/api/src/context.ts).
         *
         * The path is the opposite case and comes with the merge rather than around it: the old
         * `publish_site` had no `path` parameter at all, so a public deployment of a folder landed
         * on a file index - which is the exact failure the private half's `path` was written for,
         * and it is worse in public. `entryPath` is stored on the row above and apps/api applies it
         * to every address it hands out, for both visibilities; this line is what stops the URL the
         * model is handed from disagreeing with the one the owner's Preview tab shows.
         */
        url: previewUrl(context.config.PREVIEW_BASE_URL, published.slug, undefined, entryPath),
        visibility: 'public',
        expiresAt: null
      };
      await event(context.store, task, key, 'preview', `${label} is published`, deployment);
      return deployment;
    }
    default:
      /*
       * Unreachable: the table in `tool-dispatch.ts` is what chooses this module, and it only
       * names the tools above. Kept so that a tool added to the table and forgotten here fails
       * loudly on the first call rather than returning `undefined` to the model.
       */
      throw new Error(`Unknown tool ${call.name}`);
  }
}
