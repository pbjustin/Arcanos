const {
  GraphQLID,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLSchema,
  GraphQLString
} = require('graphql');
const { fromGlobalId, nodeDefinitions } = require('graphql-relay');
const { createModuleType } = require('./types/moduleType');
const { createSystemStatusType } = require('./types/systemStatusType');
const { getModules, getModuleById, getModulesHash } = require('./store/modules');
const { getSystemStatus } = require('./store/systemStatus');

const typeMap = {};
const { nodeInterface, nodeField } = nodeDefinitions(
  (globalId) => {
    const { type, id } = fromGlobalId(globalId);
    if (type === 'Module') {
      return getModuleById(id);
    }
    if (type === 'SystemStatus') {
      return getSystemStatus();
    }
    return null;
  },
  (obj) => typeMap[obj.__typename] || null
);

const ModuleType = createModuleType(nodeInterface);
const SystemStatusType = createSystemStatusType(nodeInterface);

typeMap.Module = ModuleType;
typeMap.SystemStatus = SystemStatusType;

const QueryType = new GraphQLObjectType({
  name: 'Query',
  fields: () => ({
    node: nodeField,
    modules: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(ModuleType))),
      resolve: () => getModules()
    },
    module: {
      type: ModuleType,
      args: {
        id: { type: new GraphQLNonNull(GraphQLID) }
      },
      resolve: (_, { id }) => {
        const parsed = fromGlobalId(id);
        if (parsed.type !== 'Module') {
          return null;
        }
        return getModuleById(parsed.id);
      }
    },
    systemStatus: {
      type: new GraphQLNonNull(SystemStatusType),
      resolve: () => getSystemStatus()
    },
    moduleHash: {
      type: new GraphQLNonNull(GraphQLString),
      resolve: () => getModulesHash()
    }
  })
});

const schema = new GraphQLSchema({ query: QueryType });

module.exports = {
  schema,
  nodeField,
  nodeInterface
};
