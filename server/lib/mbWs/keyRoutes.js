/**
 * The web UI's side of the /ws/2 API keys: list them, make one, remove one. Mounted at /api/ws2/keys.
 * (These are for the person running nuLMD, so they sit with the rest of /api, not under /ws/2.)
 */
const express = require('express');
const { KeyError } = require('./keys');

function createKeyRouter(getKeys) {
  const router = express.Router();
  const send = (res, err) => (err instanceof KeyError
    ? res.status(err.status).json({ error: err.message })
    : res.status(500).json({ error: err.message }));

  router.get('/', async (req, res) => {
    try { res.json(await getKeys().list()); } catch (err) { send(res, err); }
  });

  router.post('/', async (req, res) => {
    try {
      const created = await getKeys().create(req.body && req.body.label);
      res.status(201).json({ key: created.key, id: created.id, label: created.label, prefix: created.prefix, createdAt: created.createdAt });
    } catch (err) { send(res, err); }
  });

  router.delete('/:id', async (req, res) => {
    try {
      if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'That key cannot be removed here.' });
      const removed = await getKeys().remove(req.params.id);
      if (!removed) return res.status(404).json({ error: 'No such key.' });
      res.json({ removed: true });
    } catch (err) { send(res, err); }
  });

  return router;
}

module.exports = { createKeyRouter };
