const {
  GraphQLFloat,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLString
} = require('graphql');
const { globalIdField } = require('graphql-relay');

function createSystemStatusType(nodeInterface) {
  return new GraphQLObjectType({
    name: 'SystemStatus',
    interfaces: [nodeInterface],
    fields: () => ({
      id: globalIdField('SystemStatus', (status) => status.id),
      status: { type: new GraphQLNonNull(GraphQLString) },
      timestamp: { type: new GraphQLNonNull(GraphQLString) },
      uptime: { type: new GraphQLNonNull(GraphQLFloat) }
    })
  });
}

module.exports = { createSystemStatusType };
