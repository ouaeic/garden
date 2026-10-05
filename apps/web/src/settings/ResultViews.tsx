import { useState } from 'react';
import type { OwnerPreferences } from '@garden/contracts';
import { put } from '../client.js';
import { ActionFeedback, Section, useAction, useResource } from '../management.js';

/**
 * Whether the agent may draw a result as a live page. Off removes the one line that offers it, so
 * a turn never spends output on a view the owner does not want.
 */
export function ResultViewSettings() {
  const resource = useResource<{ preferences: OwnerPreferences }>('/v1/account/preferences');
  const action = useAction();
  // Shown as chosen at once; a failed save puts the stored value back.
  const [chosen, setChosen] = useState<boolean | null>(null);
  const enabled = chosen ?? resource.value?.preferences.resultViews !== false;
  return (
    <Section title="Results" description="Applies to the next message you send.">
      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={enabled}
          disabled={!resource.value || action.busy}
          aria-describedby="result-views-hint"
          onChange={(event) => {
            const resultViews = event.target.checked;
            setChosen(resultViews);
            void action
              .run(
                () => put('/v1/account/preferences', { resultViews }),
                resultViews ? 'Live views on' : 'Live views off'
              )
              .then((saved) => {
                if (!saved) setChosen(null);
                resource.refresh();
              });
          }}
        />
        Let the agent draw results as live views
      </label>
      <p className="muted" id="result-views-hint">
        When a chart, comparison or layout says more than prose, the agent can publish one page you
        can circle and comment on. Each view is written once and then edited in place, and what it
        cost shows in Spending like any other answer.
      </p>
      <ActionFeedback action={action} />
    </Section>
  );
}
