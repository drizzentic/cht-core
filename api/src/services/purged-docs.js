const db = require('../db');
const environment = require('../environment');
const purgingUtils = require('@medic/purging-utils');
const cache = require('./cache');
const crypto = require('crypto');
const logger = require('../logger');

const purgeDbs = {};
const getPurgeDb = (roles) => {
  const hash = purgingUtils.getRoleHash(roles);
  if (!purgeDbs[hash]) {
    purgeDbs[hash] = db.get(purgingUtils.getPurgeDbName(environment.db, hash));
  }
  return purgeDbs[hash];
};

const getCacheKey = (roles, docIds) => {
  const hash = crypto
    .createHash('md5')
    .update(JSON.stringify(docIds), 'utf8')
    .digest('hex');

  return `purged-${JSON.stringify(roles)}-${hash}`;
};

const regex = new RegExp(/^purged-.+-.+$/);
// clears all purge caches
const clearCache = () => {
  const keysToDelete = cache.keys().filter(key => regex.test(key));
  cache.del(keysToDelete);
};

const getPurgedIdsFromChanges = result => {
  const purgedIds = [];
  if (!result || !result.results) {
    return purgedIds;
  }

  result.results.forEach(change => {
    if (!change.deleted) {
      purgedIds.push(purgingUtils.extractId(change.id));
    }
  });
  return purgedIds;
};

const getPurgedIds = (roles, docIds) => {
  if (!docIds || !docIds.length || !roles || !roles.length) {
    return Promise.resolve([]);
  }

  const cacheKey = getCacheKey(roles, docIds);
  const cached = cache.get(cacheKey);
  if (cached) {
    cache.ttl(cacheKey);
    return Promise.resolve(cached);
  }

  const purgeDb = getPurgeDb(roles);
  const ids = docIds.map(purgingUtils.getPurgedId);

  // requesting _changes instead of _all_docs because it's roughly twice faster
  return purgeDb
    .changes({ doc_ids: ids, batch_size: ids.length + 1, seq_interval: ids.length })
    .then(result => {
      const purgeIds = getPurgedIdsFromChanges(result);
      // todo think about storing the last_seq here so you don't rely on `now` when writing the checkpointer
      cache.set(cacheKey, purgeIds);
      return purgeIds;
    });
};

const getPurgedIdsSince = (roles, docIds, { checkPointerId = '', limit = 100 } = {}) => {
  if (!docIds || !docIds.length || !roles || !roles.length) {
    return Promise.resolve([]);
  }

  const purgeDb = getPurgeDb(roles);
  const ids = docIds.map(purgingUtils.getPurgedId);

  return getCheckPointer(purgeDb, checkPointerId)
    .then(checkPointer => {
      const opts = {
        doc_ids: ids,
        batch_size: ids.length + 1,
        limit: limit,
        since: checkPointer.last_seq,
        seq_interval: ids.length
      };

      return purgeDb.changes(opts);
    })
    .then(result => {
      const purgedDocIds = getPurgedIdsFromChanges(result);
      return {
        purgedDocIds,
        lastSeq: result.last_seq
      };
    });
};

const getCheckPointer = (db, checkPointerId) => db
  .get(`_local/${checkPointerId}`)
  .catch(() => ({
    _id: `_local/${checkPointerId}`,
    last_seq: 0
  }));

const writeCheckPointer = (roles, checkPointerId, seq = 0) => {
  const purgeDb = getPurgeDb(roles);

  return Promise
    .all([
      getCheckPointer(purgeDb, checkPointerId),
      purgeDb.info()
    ])
    .then(([ checkPointer, info ]) => {
      checkPointer.last_seq = seq === 'now' ? info.update_seq : seq;
      purgeDb.put(checkPointer);
    });
};

const listen = () => {
  db.sentinel
    .changes({ live: true, since: 'now' })
    .on('change', change => {
      if (change.id.startsWith('purgelog:') && change.changes[0].rev.startsWith('1-')) {
        clearCache();
      }
    })
    .on('error', err => {
      logger.error('Error watching sentinel changes, restarting: %o', err);
      listen();
    });
};

let inited = false;
const init = () => {
  if (inited) {
    return;
  }
  listen();
  inited = true;
};

module.exports = {
  getPurgedIds,
  getPurgedIdsSince,
  writeCheckPointer,
  init,
};
