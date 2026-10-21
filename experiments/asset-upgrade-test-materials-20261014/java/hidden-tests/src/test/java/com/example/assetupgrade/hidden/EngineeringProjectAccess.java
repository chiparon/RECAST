package com.example.assetupgrade.hidden;

import com.example.assetupgrade.common.*;
import com.example.assetupgrade.order.*;
import com.example.assetupgrade.persistence.TransactionPort;
import com.example.assetupgrade.routing.*;
import com.example.assetupgrade.security.*;
import javax.sql.DataSource;
import java.lang.reflect.*;
import java.time.Instant;
import java.util.*;
import java.util.function.Function;
import static org.junit.jupiter.api.Assertions.*;

/** API/DTO conversion only. All decisions and state remain in production classes. */
final class EngineeringProjectAccess {
    static final String PKG = "com.example.assetupgrade.";
    static final Instant NOW = Instant.parse("2026-01-01T00:00:00Z");
    final int profile; // 0: published map seams; 19: section settings; 21: flat typed settings.
    EngineeringProjectAccess() throws Exception {
        profile = !type("messaging.MessageSerializer").isInterface() ? 0
                : exists("config.ConfigurationLoader$Settings") ? 19 : 21;
    }
    static Class<?> type(String name) throws ClassNotFoundException { return Class.forName(PKG + name); }
    static boolean exists(String name) { try { type(name); return true; } catch (ClassNotFoundException e) { return false; } }
    static Class<?> boxed(Class<?> cls) {
        if (cls == boolean.class) return Boolean.class;
        if (cls == int.class) return Integer.class;
        if (cls == long.class) return Long.class;
        return cls;
    }
    static boolean matches(Class<?>[] parameters, Object[] args) {
        if (parameters.length != args.length) return false;
        for (int i=0;i<args.length;i++) if (args[i] != null && !boxed(parameters[i]).isInstance(args[i])) return false;
        return true;
    }
    static Object create(String name, Object... args) throws Exception {
        Class<?> cls = type(name);
        for (Constructor<?> ctor:cls.getConstructors()) if (matches(ctor.getParameterTypes(), args)) {
            try { return ctor.newInstance(args); } catch (InvocationTargetException e) { throw cause(e); }
        }
        throw new NoSuchMethodException("No compatible constructor for " + name + " (" + args.length + " arguments)");
    }
    static Exception cause(InvocationTargetException ex) {
        Throwable cause = ex.getCause();
        if (cause instanceof Error error) throw error;
        return cause instanceof Exception error ? error : new Exception(cause);
    }
    static Object call(Object receiver, String name, Object... args) throws Exception {
        Class<?> cls = receiver instanceof Class<?> c ? c : receiver.getClass();
        for (Method method:cls.getMethods()) if (method.getName().equals(name) && matches(method.getParameterTypes(),args)
                && (!(receiver instanceof Class<?>) || Modifier.isStatic(method.getModifiers()))) {
            method.setAccessible(true);
            try { return method.invoke(receiver instanceof Class<?> ? null : receiver,args); }
            catch (InvocationTargetException e) { throw cause(e); }
        }
        throw new NoSuchMethodException("No compatible method " + cls.getName() + "." + name);
    }
    static boolean has(Class<?> cls, String name, int arity) {
        return Arrays.stream(cls.getMethods()).anyMatch(m -> m.getName().equals(name) && m.getParameterCount()==arity);
    }
    static Object proxy(String name, InvocationHandler handler) throws Exception {
        Class<?> cls=type(name);return Proxy.newProxyInstance(cls.getClassLoader(),new Class<?>[]{cls},(p,m,a)-> {
            if (m.getDeclaringClass()==Object.class) return switch(m.getName()) {case "toString" -> "host fixture "+name;case "hashCode" -> System.identityHashCode(p);case "equals" -> p==a[0];default -> null;};
            return handler.invoke(p,m,a);
        });
    }
    static Object emptyResult(Class<?> cls) {
        if (cls==Optional.class) return Optional.empty();
        if (Set.class.isAssignableFrom(cls)) return Set.of();
        if (Map.class.isAssignableFrom(cls)) return Map.of();
        if (Collection.class.isAssignableFrom(cls)) return List.of();
        if (cls==boolean.class) return false;
        return null;
    }
    static Object execute(Object obj,Object input) throws Exception {return call(obj,"execute",input);}

    @SuppressWarnings("unchecked")
    Map<String,String> configuration(Map<String,String> defaults,Map<String,String> overrides) throws Exception {
        if (profile==0) {
            Object result=execute(create("config.ConfigurationLoader"),Map.of("defaults",defaults,"overrides",overrides));
            assertNotSame(defaults,result);assertNotSame(overrides,result);
            return (Map<String,String>)assertInstanceOf(Map.class,result);
        }
        Map<String,String> nativeDefaults=flat(defaults), nativeOverrides=flat(overrides);
        Object settings;
        if (profile==19) {
            Map<String,Map<String,String>> sections=sections(nativeDefaults);
            Map<String,String> environment=new HashMap<>();
            nativeOverrides.forEach((k,v)->environment.put("ASSETUPGRADE_"+k.replace('.','_').toUpperCase(Locale.ROOT),v));
            Map<String,Map<String,String>> before=new HashMap<>();sections.forEach((k,v)->before.put(k,new HashMap<>(v)));
            Map<String,String> envBefore=new HashMap<>(environment);
            settings=call(create("config.ConfigurationLoader",sections,environment),"load");
            assertEquals(before,sections,"native defaults mutated");assertEquals(envBefore,environment,"native overrides mutated");
        } else {
            Map<String,String> beforeDefaults=new HashMap<>(nativeDefaults),beforeOverrides=new HashMap<>(nativeOverrides);
            Function<String,String> absent=k->null;
            settings=call(create("config.ConfigurationLoader",nativeDefaults,absent,absent),"load",nativeOverrides);
            assertEquals(beforeDefaults,nativeDefaults);assertEquals(beforeOverrides,nativeOverrides);
        }
        Map<String,String> result=new LinkedHashMap<>();
        Set<String> requested=new HashSet<>(defaults.keySet());requested.addAll(overrides.keySet());
        for (String key:requested) {
            if (profile==19) {
                String nativeKey=key(key);int dot=nativeKey.indexOf('.');
                Map<String,String> section=(Map<String,String>)call(settings,"section",nativeKey.substring(0,dot));
                result.put(key,section.get(nativeKey.substring(dot+1)));
            } else result.put(key,((Map<String,String>)call(settings,"toFlatMap")).get(key(key)));
        }
        return result;
    }
    String key(String key) {
        if(profile==19)return switch(key){case "environment"->"environment.name";case "retry.maximumAttempts"->"retry.maxAttempts";case "attachment.maximumBytes"->"attachment.maxBytes";case "tenant.name"->"tenant.defaultTenant";default->key;};
        return switch(key){case "retry.maximumAttempts"->"retry.maxattempts";case "attachment.maximumBytes"->"attachment.maxsizebytes";case "tenant.name"->"tenant.default";default->key;};
    }
    Map<String,String> flat(Map<String,String> input) {Map<String,String> result=new HashMap<>();input.forEach((k,v)->result.put(key(k),v));return result;}
    static Map<String,Map<String,String>> sections(Map<String,String> flat) {
        Map<String,Map<String,String>> result=new HashMap<>();
        flat.forEach((k,v)->{int dot=k.indexOf('.');result.computeIfAbsent(k.substring(0,dot),s->new HashMap<>()).put(k.substring(dot+1),v);});return result;
    }
    void validate(Map<String,String> config) throws Exception {
        Object input=config;
        if(profile==19) input=call(create("config.ConfigurationLoader",sections(flat(config))),"load");
        else if(profile==21) {
            Map<String,String> complete=flat(config);complete.put("messaging.maxattempts","2"); // consistent positive fixture
            Object base=call(type("config.EnvironmentProperties"),"defaults");input=call(base,"merge",complete);
        }
        execute(create("config.ConfigurationValidator"),input);
    }

    record Repository(Object nativeObject) {}
    Repository repository(DataSource source,TransactionPort tx) throws Exception {
        if(profile==21)return new Repository(create("adapters.JdbcOrderRepository"));
        if(profile==19 && tx!=null) return new Repository(create("adapters.JdbcOrderRepository",source,tx));
        return new Repository(create("adapters.JdbcOrderRepository",source));
    }
    TransactionPort transaction(DataSource source) throws Exception {
        return (TransactionPort)(profile==21?create("adapters.PostgresTransactionAdapter"):create("adapters.PostgresTransactionAdapter",source));
    }
    void save(Repository repo,String tenant,String id,String status) throws Exception {
        String description="quoted ' 中文";
        if(profile==0) {call(repo.nativeObject(),"invoke",Map.of("action","save","tenantId",tenant,"id",id,"record",Map.of("status",status,"description",description)));return;}
        TenantId t=new TenantId(tenant);
        OrderRequest order=new OrderRequest(id,t,new ActorId("fixture"),List.of(new OrderLine(description,1,100L)),"USD");
        if(profile==19) {
            Reservation reservation="COMMITTING".equals(status)?null:new Reservation("r-"+id,t,id,Map.of(description,1),NOW.plusSeconds(300),"ROLLED_BACK".equals(status));
            call(repo.nativeObject(),"commit",order,reservation);
        } else call(repo.nativeObject(),"save",new OrderSnapshot(order,OrderStatus.valueOf(status),null,100L,NOW,1));
    }
    @SuppressWarnings("unchecked")
    Map<String,String> find(Repository repo,String tenant,String id) throws Exception {
        if(profile==0)return (Map<String,String>)call(repo.nativeObject(),"invoke",Map.of("action","find","tenantId",tenant,"id",id));
        Optional<?> row=(Optional<?>)call(repo.nativeObject(),profile==19?"findOrder":"find",new TenantId(tenant),id);
        if(row.isEmpty())return null;
        OrderSnapshot snapshot=(OrderSnapshot)row.get();
        return Map.of("status",snapshot.status().name(),"description",snapshot.request().lines().get(0).sku());
    }
    void delete(Repository repo,String tenant,String id) throws Exception {
        if(profile==0){call(repo.nativeObject(),"invoke",Map.of("action","delete","tenantId",tenant,"id",id));return;}
        if(!has(repo.nativeObject().getClass(),"delete",2))throw new AssertionError("Production order repository has no order deletion operation");
        call(repo.nativeObject(),"delete",new TenantId(tenant),id);
    }

    @SuppressWarnings("unchecked")
    void serialization(Map<String,String> expected) throws Exception {
        if(profile==0) {
            Class<?> envelope=type("messaging.MessageEnvelope"),serializer=type("messaging.MessageSerializer");
            Map<String,String> attributes=new HashMap<>(expected);String event=attributes.remove("eventId");
            Object nativeEnvelope=envelope.getConstructor(String.class,Map.class).newInstance(event,attributes);
            String encoded=(String)call(serializer,"serialize",nativeEnvelope);
            Object decoded=call(serializer,"deserialize",encoded);
            assertEquals(event,call(decoded,"marker"));assertEquals(attributes,call(decoded,"attributes"));
            rejectMalformed(()->call(serializer,"deserialize","{invalid-payload"));return;
        }
        Class<?> serializer=type("messaging.MessageSerializer");
        if(!has(serializer,"json",0))throw new AssertionError("MessageSerializer is only an interface: no project-provided concrete codec or factory exists");
        Object codec=call(serializer,"json");
        TenantId tenant=new TenantId(expected.get("tenantId"));
        CorrelationId correlation=new CorrelationId(expected.get("correlationId"));
        Object headers=create("messaging.MessageHeaders",tenant,correlation,"application/json",expected.get("eventId"),1,expected);
        byte[] payload=expected.get("payload").getBytes(java.nio.charset.StandardCharsets.UTF_8);
        Object envelope=create("messaging.MessageEnvelope",tenant,correlation,"fixture-topic",headers,payload,NOW);
        byte[] bytes=(byte[])call(codec,"serialize",envelope);
        Object decoded=call(codec,"deserialize",bytes,type("messaging.MessageEnvelope"));
        assertEquals(tenant,call(decoded,"tenantId"));assertEquals(correlation,call(decoded,"correlationId"));
        assertEquals("fixture-topic",call(decoded,"topic"));assertArrayEquals(payload,(byte[])call(decoded,"payload"));
        Object decodedHeaders=call(decoded,"headers");
        assertEquals(expected.get("eventId"),call(decodedHeaders,"messageId"));assertEquals(expected,call(decodedHeaders,"attributes"));
        rejectMalformed(()->call(codec,"deserialize","{invalid-payload".getBytes(java.nio.charset.StandardCharsets.UTF_8),type("messaging.MessageEnvelope")));
    }
    interface Attempt {Object run() throws Exception;}
    static void rejectMalformed(Attempt attempt) {
        Exception ex=assertThrows(Exception.class,attempt::run);
        // A successful round trip above already establishes a usable codec. Native
        // codecs may wrap parse errors in their own domain exception type.
        assertInstanceOf(RuntimeException.class,ex,"Malformed message rejection must come from the codec, not a missing reflective API");
    }
    boolean route(String owner,boolean active,String requestTenant) throws Exception {
        Map<String,String> attributes=new HashMap<>(Map.of("active",String.valueOf(active),"target","fixture"));
        if(owner!=null)attributes.put(profile==19?"tenant":"tenantId",owner);
        RouteDefinition route=new RouteDefinition("route",attributes);
        MessageRequest request=new MessageRequest("route",Map.of("tenantId",requestTenant));
        if(profile==0)return (Boolean)call(type("routing.RouteFilter"),"allows",route,request);
        Object registry=call(type("routing.RouteRegistry"),"inMemory");
        if(profile==19) {
            call(registry,"register",new TenantId(owner==null?requestTenant:owner),route);
            Object resolver=call(type("routing.RouteResolver"),"over",registry);
            return ((Optional<?>)call(resolver,"find",new TenantId(requestTenant),request)).isPresent();
        }
        call(registry,"register",route);
        Object resolver=call(type("routing.RouteResolver"),"of",registry,null);
        return ((Optional<?>)call(resolver,"resolve",request)).isPresent();
    }

    void boundary(String request,String resource) throws Exception {
        if(profile==0){execute(create("security.TenantBoundaryFilter"),Map.of("requestTenantId",request,"resourceTenantId",resource));return;}
        TenantId tenant=new TenantId(request),resourceTenant=new TenantId(resource);
        ActorId actor=new ActorId("fixture");CorrelationId correlation=new CorrelationId("fixture-correlation");
        CommandMetadata metadata=new CommandMetadata(tenant,actor,correlation,NOW);
        Set<Permission> permissions=EnumSet.allOf(Permission.class);
        Object clock=proxy("common.TimeProvider",(p,m,a)->NOW);
        Object identity=proxy("security.IdentityPort",(p,m,a)->new TenantScope((TenantId)a[0],(ActorId)a[1],Set.of("fixture"),permissions,NOW.plusSeconds(300)));
        if(profile==19) {
            Object resolver=create("security.TenantScopeResolver",identity,null,null,clock);
            Object policy=proxy("security.AccessPolicy",(p,m,a)->new AuthorizationDecision(true,"fixture allow",permissions));
            Object filter=create("security.TenantBoundaryFilter",resolver,policy,null);
            Object context=create("common.OperationContext",metadata,"fixture",null);
            call(filter,"guard",context,Permission.ATTACHMENT_SUBMIT,"fixture","resource",resourceTenant);
        } else {
            Object roles=proxy("security.RoleMappingPort",(p,m,a)->emptyResult(m.getReturnType()));
            Object cache=proxy("security.PermissionCachePort",(p,m,a)->emptyResult(m.getReturnType()));
            Object policy=create("security.PermissionPolicy",roles,cache,clock);
            Object resolver=create("security.TenantScopeResolver",identity,policy,clock);
            Object context=create("security.ActorContextProvider",resolver,clock);
            call(create("security.TenantBoundaryFilter",context,clock),"enforce",metadata,resourceTenant);
        }
    }
    Object metrics() throws Exception {return create("telemetry.MetricsAdapter");}
    void increment(Object metrics,String tenant,int delta) throws Exception {
        if(profile==0){execute(metrics,Map.of("action","increment","tenantId",tenant,"metric","orders","delta",delta));return;}
        for(int i=0;i<delta;i++)call(metrics,"increment","orders",Map.of("tenantId",tenant));
    }
    long counter(Object metrics,String tenant) throws Exception {
        if(profile==0){Map<?,?> map=(Map<?,?>)execute(metrics,Map.of("action","snapshot","tenantId",tenant));Object n=map.get("orders");return n==null?0:((Number)n).longValue();}
        if(profile==21)return ((Number)call(metrics,"counter","orders",Map.of("tenantId",tenant))).longValue();
        return ((Number)call(metrics,"counter","orders")).longValue(); // no host-created partitioning
    }
    boolean ready(Map<String,Boolean> dependencies) throws Exception {
        if(profile==0)return (Boolean)execute(create("telemetry.ReadinessProbe"),dependencies);
        List<Object> checks=new ArrayList<>();
        for(var entry:dependencies.entrySet())checks.add(proxy("observability.HealthCheck",(p,m,a)-> {
            if(m.getName().equals("id"))return entry.getKey();
            if(m.getReturnType()==boolean.class)return true;
            Class<?> status=type("observability.HealthStatus");
            if(profile==19)return call(status,entry.getValue()?"up":"down",entry.getValue()?new Object[]{}:new Object[]{"fixture failure"});
            return entry.getValue()?call(status,"up",entry.getKey()):call(status,"down",entry.getKey(),"fixture failure");
        }));
        Object readiness;
        if(profile==19)readiness=create("telemetry.ReadinessProbe",checks);
        else {Object endpoint=create("telemetry.HealthEndpoint",checks);readiness=create("telemetry.ReadinessProbe",endpoint);call(readiness,"markStarted");}
        return (Boolean)call(readiness,"isReady");
    }
    Object local() throws Exception {
        if(profile==0)return call(type("application.ApplicationModule"),"createLocal");
        if(profile==19)return call(call(type("AssetUpgradeGateway"),"bootstrap"),"module");
        return call(type("application.ApplicationModule"),"defaults");
    }
    List<Object> services(Object local) throws Exception {
        String[] methods=profile==0?new String[]{"attachmentService","workflowService","reconciliationService","orderService"}
            :profile==19?new String[]{"attachmentApplicationService","workflowApplicationService","reconciliationApplicationService","orderApplicationService"}
            :new String[]{"attachments","workflows","reconciliations","orders"};
        List<Object> services=new ArrayList<>();for(String method:methods)services.add(call(local,method));return services;
    }
}
