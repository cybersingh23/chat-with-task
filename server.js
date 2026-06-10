import express from 'express';
import path from 'node:path';
import { config } from './src/config.js';
import { ensureWorkspace } from './src/workspace.js';
import { api } from './src/routes/api.js';

ensureWorkspace();

const app = express();
app.use('/api', api);
app.use(express.static(path.join(config.projectRoot, 'public')));

app.get('/task/:bucket/:id', (req, res) =>
  res.sendFile(path.join(config.projectRoot, 'public', 'task.html'))
);

app.listen(config.port, () => {
  console.log(`chat-with-task on http://localhost:${config.port}`);
  console.log(`workspace: ${config.workspaceRoot}`);
  console.log(`delivery roots: ${config.deliveryRoots.join(', ')}`);
  console.log(`model: ${config.litellm.model} via ${config.litellm.baseURL}`);
});
