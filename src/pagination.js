// Pagination utilities

function encodeCursor(data) {
  return Buffer.from(JSON.stringify(data)).toString('base64');
}

function decodeCursor(cursor) {
  try {
    return JSON.parse(Buffer.from(cursor, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

function getPagination(req) {
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 200);
  const cursor = req.query.cursor;
  
  return {
    limit,
    cursor: cursor ? decodeCursor(cursor) : null
  };
}

async function paginateQuery(query, params, pagination, orderBy = 'ts DESC, id DESC') {
  const { limit, cursor } = pagination;
  
  let whereClause = '';
  let queryParams = [...params];
  
  if (cursor && cursor.last_id && cursor.last_ts) {
    whereClause = ` AND (ts < $${queryParams.length + 1} OR (ts = $${queryParams.length + 1} AND id < $${queryParams.length + 2}))`;
    queryParams.push(cursor.last_ts, cursor.last_id);
  }
  
  const fullQuery = `${query} ${whereClause} ORDER BY ${orderBy} LIMIT $${queryParams.length + 1}`;
  queryParams.push(limit + 1); // Fetch one extra to check if there are more
  
  const result = await require('./db').query(fullQuery, queryParams);
  const items = result.rows.slice(0, limit);
  const hasMore = result.rows.length > limit;
  
  let nextCursor = null;
  if (hasMore && items.length > 0) {
    const lastItem = items[items.length - 1];
    nextCursor = encodeCursor({
      last_id: lastItem.id,
      last_ts: lastItem.ts
    });
  }
  
  return {
    items,
    next_cursor: nextCursor
  };
}

module.exports = {
  getPagination,
  paginateQuery,
  encodeCursor,
  decodeCursor
};
