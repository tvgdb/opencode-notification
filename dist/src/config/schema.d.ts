import * as z from "zod";
export declare const EventConfigSchema: z.ZodObject<{
    enabled: z.ZodDefault<z.ZodBoolean>;
    delay: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
export declare const ConfigSchema: z.ZodObject<{
    delay: z.ZodDefault<z.ZodNumber>;
    enabled: z.ZodDefault<z.ZodBoolean>;
    response_ready: z.ZodDefault<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        delay: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>;
    error: z.ZodDefault<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        delay: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>;
    permission_asked: z.ZodDefault<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        delay: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>;
    question_asked: z.ZodDefault<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        delay: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export type EventConfig = z.infer<typeof EventConfigSchema>;
export type Config = z.infer<typeof ConfigSchema>;
//# sourceMappingURL=schema.d.ts.map