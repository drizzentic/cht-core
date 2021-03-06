const actionTypes = require('../actions/actionTypes');
const initialState = {
  selected: null,
  targetAggregates: [],
  error: false,
};

module.exports = function(state, action) {
  if (typeof state === 'undefined') {
    state = initialState;
  }

  switch (action.type) {
  case actionTypes.SET_SELECTED_TARGET_AGGREGATE:
    return Object.assign({}, state, { selected: action.payload.selected });
  case actionTypes.SET_TARGET_AGGREGATES:
    return Object.assign({}, state, { targetAggregates: action.payload.targetAggregates });
  case actionTypes.SET_TARGET_AGGREGATES_ERROR:
    return Object.assign({}, state, { error: action.payload.error });
  default:
    return state;
  }
};
