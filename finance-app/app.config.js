module.exports = ({ config }) => {
  const freeSideload = process.env.FREE_IOS_SIDELOAD === '1';
  const base = {
    ...config,
    extra: {
      ...(config.extra || {}),
      freeSideload,
    },
  };
  if (!freeSideload) return base;
  const plugins = (config.plugins || []).filter((plugin) => {
    const name = Array.isArray(plugin) ? plugin[0] : plugin;
    return name !== 'expo-widgets' && name !== 'expo-notifications';
  });
  return {
    ...base,
    runtimeVersion: `${config.version}-free-sideload`,
    updates: {
      ...(config.updates || {}),
      requestHeaders: {
        ...(config.updates?.requestHeaders || {}),
        'expo-channel-name': 'free-sideload',
      },
    },
    plugins: [...plugins, './plugins/with-free-sideload'],
  };
};
