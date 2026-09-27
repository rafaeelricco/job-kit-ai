export { Callable as default }

function Callable<T extends new (...args: never[]) => unknown>(classname: T) {
  function apply(target: T, _: unknown, argumentsList: ConstructorParameters<T>): InstanceType<T> {
    return new target(...argumentsList) as InstanceType<T>
  }
  return new Proxy(classname, { apply }) as T & ((...args: ConstructorParameters<T>) => InstanceType<T>)
}
