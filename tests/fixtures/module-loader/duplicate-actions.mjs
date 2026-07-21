const actions = {
  async duplicate() {
    return 'first';
  },
};

actions.duplicate = async () => 'second';

export default {
  name: 'FIXTURE:DUPLICATE_ACTIONS',
  actions,
};
