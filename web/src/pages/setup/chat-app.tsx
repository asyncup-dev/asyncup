import { Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { CopyRow, StaticRow } from '../../components/copy-row';
import { fromMutation, VerifyStatus } from '../../components/verify-status';
import { chatAppValues, projectNumberOf, stepDone, useSaveSettings, useSetupProgress, useVerify } from '../../lib/setup';
import { StepActions, StepPage } from './layout';

export const CHAT_EVENT_POLL_MS = 5_000;

export function ChatAppPage() {
  const progress = useSetupProgress();
  const save = useSaveSettings();
  const verify = useVerify('chat-event');
  const values = chatAppValues(typeof location !== 'undefined' ? location.origin : '');
  const audience = progress.data?.settings.chat.audience ?? '';
  const [listening, setListening] = useState(false);
  const verified = progress.data ? stepDone(progress.data, 'chat-app') : false;

  // Make sure the app URL is an accepted audience before Google starts signing for it.
  const audienceReady = audience.split(/[\s,]+/).includes(values.endpointUrl);
  const saveAudience = () => {
    const number = projectNumberOf(audience);
    void save.mutateAsync({ chatAudience: [number, values.endpointUrl].filter(Boolean).join(' ') });
  };

  // Listen for the first verified event: poll until it lands, then stop.
  useEffect(() => {
    if (!listening || verified) return;
    verify.mutate();
    const timer = setInterval(() => verify.mutate(), CHAT_EVENT_POLL_MS);
    return () => clearInterval(timer);
  }, [listening, verified]); // eslint-disable-line react-hooks/exhaustive-deps -- verify is stable per render of this page


  return (
    <StepPage id="chat-app" title="Configure the Chat app" lede="Tell Google Chat where AsyncUp lives. Paste these values into the Chat API configuration page — every field below is exactly what Google asks for.">
      <a className="btn" href="https://console.cloud.google.com/apis/api/chat.googleapis.com/hangouts-chat" target="_blank" rel="noreferrer">Open the Chat API configuration page ↗</a>
      <div className="card">
        <div className="section-head t-label">Application info</div>
        <CopyRow label="App name" hint="Up to 25 alphanumeric characters" value={values.appName} mono={false} />
        <CopyRow label="Avatar URL" hint="HTTPS · square PNG or JPEG · 256×256 or larger" value={values.avatarUrl} />
        <CopyRow label="Description" hint="Up to 40 alphanumeric characters" value={values.description} mono={false} />
        <div className="section-head t-label">Interactive features</div>
        <StaticRow label="Enable interactive features" hint="Off by default — switch it on to reveal the settings below" value="On" />
        <StaticRow label="Join spaces and group conversations" hint="Functionality · direct messages work regardless" value="Ticked" />
        <CopyRow label="HTTP endpoint URL" hint="Connection settings · where Google sends every event" value={values.endpointUrl} />
        <StaticRow label="Authentication Audience" hint="Recommended by Google. AsyncUp also accepts Project number." value="HTTP endpoint URL" />
        <div className="section-head t-label">Optional</div>
        <StaticRow label="Commands" hint="AsyncUp uses @mentions, not slash commands" value="Leave empty" />
        <StaticRow label="Link previews" value="Leave off" />
        <StaticRow label="Visibility" hint="Or restrict to specific people and Google Groups" value="Everyone in your domain" />
      </div>
      {!audienceReady ? (
        <div className="verify verify-idle row">
          <span className="grow">AsyncUp will accept events signed for the HTTP endpoint URL above once you save it as the audience.</span>
          <button type="button" className="btn" disabled={save.isPending} onClick={saveAudience}>Save audience</button>
        </div>
      ) : null}
      {save.isError ? <div className="alert" role="alert">{save.error.message}</div> : null}
      <div>
        <div className="t-h3">Check the connection</div>
        <p className="lede">Once you save in Google Cloud, send any message to AsyncUp in Chat. We listen for the first event and verify its signature.</p>
        <div style={{ marginTop: 12 }}>
          {verified ? (
            <div className="verify verify-pass" role="status"><strong>Verified</strong> · A signed event from Google Chat arrived at {progress.data?.health.lastEventAt}.</div>
          ) : (
            <VerifyStatus state={fromMutation(verify)} idle="No event received yet." />
          )}
        </div>
      </div>
      <StepActions back="/setup/service-account">
        {!verified ? (
          <button type="button" className="btn" onClick={() => setListening(!listening)}>{listening ? 'Stop listening' : 'Start listening'}</button>
        ) : null}
        <Link to="/setup/sign-in" className="btn btn-primary" disabled={!verified} aria-disabled={!verified}>Continue</Link>
      </StepActions>
      {!verified ? <p className="t-caption" style={{ margin: 0 }}>Continue unlocks when the first event is verified.</p> : null}
    </StepPage>
  );
}
