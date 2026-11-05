const fam = n => Object.fromEntries([50,100,200,300,400,500,600,700,800,900,950].map(s => [s, `rgb(var(--${n}-${s}) / <alpha-value>)`]));
module.exports = {
  content: ['./public/index.html', './public/app.js'],
  theme: {
    colors: {
      transparent: 'transparent', current: 'currentColor', inherit: 'inherit',
      white: 'rgb(var(--white) / <alpha-value>)', black: 'rgb(var(--black) / <alpha-value>)',
      slate: fam('slate'), gray: fam('slate'), brand: fam('brand'), emerald: fam('emerald'), rose: fam('rose'),
      amber: fam('amber'), sky: fam('sky'), blue: fam('blue')
    },
    ringColor: ({ theme }) => ({ DEFAULT: 'rgb(var(--brand-600) / 0.5)', ...theme('colors') }),
    ringOffsetColor: ({ theme }) => ({ DEFAULT: 'rgb(var(--white))', ...theme('colors') }),
    boxShadow: {
      none: 'none', sm: 'var(--shadow-raised)', DEFAULT: 'var(--shadow-raised)', md: 'var(--shadow-raised)',
      lg: 'var(--shadow-float)', xl: 'var(--shadow-float)', '2xl': 'var(--shadow-float)'
    },
    extend: {
      fontFamily: { sans: ['var(--font-body)'], display: ['var(--font-display)'] },
      spacing: { '0.5': 'var(--space-3xs)', '1': 'var(--space-2xs)', '2': 'var(--space-xs)', '3': 'var(--space-sm)', '4': 'var(--space-md)', '6': 'var(--space-lg)', '10': 'var(--space-xl)', '16': 'var(--space-2xl)', '24': 'var(--space-3xl)', '36': 'var(--space-4xl)' },
      fontWeight: { medium: '400', bold: '600', extrabold: '700', black: '700' },
      borderRadius: { lg: '8px', xl: '10px', '2xl': '12px', '3xl': '16px' }
    }
  }
};
