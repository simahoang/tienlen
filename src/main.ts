import { App } from './app';

const root = document.querySelector<HTMLDivElement>('#app');

if (!root) {
  throw new Error('Không tìm thấy phần tử #app');
}

const app = new App(root);
app.start();

if (import.meta.env.DEV) {
  window.__game = {
    client: app.client,
    snapshot: () => app.client.getSnapshot(),
  };
}
