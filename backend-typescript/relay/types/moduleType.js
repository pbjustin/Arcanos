const {
  GraphQLBoolean,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLString
} = require('graphql');
const { globalIdField } = require('graphql-relay');

function createModuleType(nodeInterface) {
  return new GraphQLObjectType({
    name: 'Module',
    interfaces: [nodeInterface],
    fields: () => ({
      id: globalIdField('Module', (moduleData) => moduleData.id),
      name: { type: new GraphQLNonNull(GraphQLString) },
      version: { type: GraphQLString },
      description: { type: GraphQLString },
      entry: { type: GraphQLString },
      permissions: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLString))) },
      enabled: { type: new GraphQLNonNull(GraphQLBoolean) }
    })
  });
}

module.exports = { createModuleType };
