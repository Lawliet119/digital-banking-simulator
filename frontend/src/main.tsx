import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/plus-jakarta-sans';
import { App } from './App';
import { NO_SOURCE, type AuthSource } from './auth/auth-source';
import { loadCloudConfig } from './auth/cloud-config';
import './styles.css';

/**
 * The user pool when `/config.json` names one; else, under `vite dev` only, tokens signed on
 * this machine. A production build has no local sign-in at all: `import.meta.env.DEV` is false
 * there, so the bundler drops that branch and the file it loads.
 */
async function chooseSource(): Promise<AuthSource> {
  const config = await loadCloudConfig();
  if (config) {
    const { CognitoSource } = await import('./auth/cognito-source');
    return new CognitoSource(config);
  }
  if (import.meta.env.DEV) {
    const { LocalDevSource } = await import('./auth/local-dev-source');
    return new LocalDevSource();
  }
  return NO_SOURCE;
}

void chooseSource().then(source => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App source={source} />
    </StrictMode>,
  );
});
