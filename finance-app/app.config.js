module.exports = ({ config }) => {
  if (process.env.FREE_IOS_SIDELOAD !== '1') return config;
  const plugins = (config.plugins || []).filter((plugin) => {
    const name = Array.isArray(plugin) ? plugin[0] : plugin;
    return name !== 'expo-widgets' && name !== 'expo-notifications';
  });
  return {
    ...config,
    plugins: [...plugins, './plugins/with-free-sideload'],
  };
};
