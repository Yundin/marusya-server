// Vendored из @v3rt3p/types#1.0.3: в 1.0.15 модуль `@v3rt3p/types/directives`
// удалён вместе с понятием device-директив в протоколе processor.
export type Directive =
  | { data: unknown, type: 'customMarusya' }
  | { data: unknown, type: 'customQuasar' }
  | { level: number, type: 'soundSetLevel' }
  | { type: 'bluetoothDisable' }
  | { type: 'bluetoothEnable' }
  | { type: 'soundLouder' }
  | { type: 'soundQuieter' }

// Вызов LLM функции-директивы из processor (types 1.0.15,
// `partialResponse.directives`); имена — из prepare.directiveFunctions.
export interface DirectiveFunctionCall {
  arguments: unknown
  name: string
}

export function convertToMarusyaCommandDirective (directive: Directive): unknown {
  switch (directive.type) {
    case 'bluetoothDisable': {
      return {
        turn_on: false,
        type: 'bluetooth_pair'
      }
    }
    case 'bluetoothEnable': {
      return {
        turn_on: true,
        type: 'bluetooth_pair'
      }
    }
    case 'customMarusya': {
      return directive.data
    }
    case 'customQuasar': {
      throw new Error('Custom Quasar directives are not supported')
    }
    case 'soundLouder': {
      return null
    }
    case 'soundQuieter': {
      return null
    }
    case 'soundSetLevel': {
      return {
        level: directive.level * 10,
        type: 'volume_control'
      }
    }
  }
}

// Конвертация вызова функции-директивы в device-директиву для vc-api.
// null — неизвестное имя или невалидные аргументы (директива отбрасывается).
export function directiveCallToDirective (call: DirectiveFunctionCall): Directive | null {
  switch (call.name) {
    case 'bluetoothDisable':
    case 'bluetoothEnable':
    case 'soundLouder':
    case 'soundQuieter': {
      return { type: call.name }
    }
    case 'soundSetLevel': {
      const arguments_ = call.arguments as null | undefined | { level?: unknown }
      if (typeof arguments_?.level !== 'number' || !Number.isFinite(arguments_.level)) {
        return null
      }
      return { level: Math.round(arguments_.level), type: 'soundSetLevel' }
    }
    default: {
      return null
    }
  }
}
