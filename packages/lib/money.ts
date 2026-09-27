export { Money, type Currency }

type Currency = "USD"

const MINOR_UNITS_PER_MAJOR: Record<Currency, number> = { USD: 100 }

/** An amount in a currency's minor units (cents for USD). */
class Money {
  readonly amountInMinorUnits: number
  readonly currency: Currency
  constructor(amountInMinorUnits: number, currency: Currency) {
    this.amountInMinorUnits = amountInMinorUnits
    this.currency = currency
  }

  /** `Money.USD(19.99)` === `new Money(1999, "USD")`. */
  static USD(amount: number): Money {
    return new Money(Math.round(amount * MINOR_UNITS_PER_MAJOR.USD), "USD")
  }

  /** Major-unit amount (dollars). */
  get amount(): number {
    return this.amountInMinorUnits / MINOR_UNITS_PER_MAJOR[this.currency]
  }
}
