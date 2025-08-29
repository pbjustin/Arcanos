const state = {
  /* ...initial memory state... */
};

export const read = () => ({ ...state });

export const write = updates => {
  Object.assign(state, updates);
};

export const reset = () => {
  Object.keys(state).forEach(key => {
    state[key] = null;
  });
};

export default { read, write, reset };
